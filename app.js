
(() => {
  'use strict';

  const STORAGE_KEY = 'dopamine-pricing-web-v1';
  const STATE_VERSION = 4;
  const SCALE = 1000000n;

  const $ = id => document.getElementById(id);
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  function parseDecimal(value) {
    let s = String(value ?? '').trim().replace(/,/g, '');
    if (!s || s === '-' || s === '.') return 0n;
    let sign = 1n;
    if (s.startsWith('-')) { sign = -1n; s = s.slice(1); }
    if (!/^\d*(\.\d*)?$/.test(s)) return 0n;
    let [whole = '0', frac = ''] = s.split('.');
    whole = whole || '0';
    frac = (frac + '000000').slice(0, 6);
    return sign * (BigInt(whole) * SCALE + BigInt(frac));
  }
  const add = (a,b) => a+b;
  const mul = (a,b) => (a*b + (a*b >= 0n ? SCALE/2n : -(SCALE/2n))) / SCALE;
  const div = (a,b) => b === 0n ? 0n : (a*SCALE) / b;
  const nonNegative = value => parseDecimal(value) < 0n ? 0n : parseDecimal(value);

  function decimalString(x, places=2) {
    const neg = x < 0n;
    if (neg) x = -x;
    const factor = 10n ** BigInt(6 - places);
    let rounded = (x + factor/2n) / factor;
    const base = 10n ** BigInt(places);
    const whole = rounded / base;
    const frac = (rounded % base).toString().padStart(places, '0');
    return `${neg ? '-' : ''}${whole.toString()}${places ? '.' + frac : ''}`;
  }
  const money = x => `¥${decimalString(x, 2)}`;
  const unitMoney = x => `¥${decimalString(x, 4)}`;
  const percent = ratio => `${decimalString(mul(ratio, parseDecimal('100')), 2)}%`;

  function createEmptyPackage(name = '套餐1') {
    return {
      id: uid('pkg'),
      name,
      products: [],
      discounts: [
        {id: uid('disc'), zhe: '7'},
        {id: uid('disc'), zhe: '8'},
        {id: uid('disc'), zhe: '8.5'}
      ],
      fees: []
    };
  }

  function createEmptyProject(name = '项目1') {
    const pkg = createEmptyPackage();
    return {
      id: uid('proj'),
      name,
      currentPackageId: pkg.id,
      costItems: [],
      packages: [pkg]
    };
  }

  function defaultState() {
    const project = createEmptyProject();
    return {
      version: STATE_VERSION,
      currentProjectId: project.id,
      projects: [project]
    };
  }

  function normalizeCostItems(items) {
    return (Array.isArray(items) ? items : []).map(item => ({
      ...item,
      type: item.type === 'combo' ? 'combo' : 'product',
      components: Array.isArray(item.components) ? item.components : [],
      listPrice: String(item.listPrice ?? '0')
    }));
  }

  function normalizeProject(project, fallbackName = '项目1') {
    const packages = Array.isArray(project?.packages) && project.packages.length
      ? project.packages
      : [createEmptyPackage()];
    const currentPackageId = packages.some(p => p.id === project?.currentPackageId)
      ? project.currentPackageId
      : packages[0].id;
    return {
      id: project?.id || uid('proj'),
      name: String(project?.name || fallbackName),
      currentPackageId,
      costItems: normalizeCostItems(project?.costItems),
      packages
    };
  }

  // V1-V6 stored prices separately on package rows. V7 owns prices by product.
  // When the same original product had different package prices, split its
  // product identity to preserve ALL previous package totals and profits.
  function migrateLegacyProductPrices(project) {
    const originalById = new Map(project.costItems.map(item => [item.id, item]));
    const byPrice = new Map();
    for (const pkg of project.packages) {
      for (const row of pkg.products) {
        const origin = originalById.get(row.costItemId);
        if (!origin) continue;
        const rawPrice = String(row.listPrice ?? '0');
        const key = parseDecimal(rawPrice).toString();
        let variants = byPrice.get(origin.id);
        if (!variants) { variants = new Map(); byPrice.set(origin.id, variants); }
        let item = variants.get(key);
        if (!item) {
          if (!variants.size) {
            item = origin;
          } else {
            item = clone(origin);
            item.id = uid('cost');
            // Keep the original product label but distinguish the legacy price.
            const suffix = `旧售价${rawPrice}`;
            item.spec = `${origin.spec ? origin.spec + ' / ' : ''}${suffix}`;
            const used = new Set(project.costItems.map(v => `${v.name}\u0000${v.spec}`));
            while (used.has(`${item.name}\u0000${item.spec}`)) item.spec += '·';
            item.components = (item.components || []).map(c => ({...c, id:uid('cmp')}));
            project.costItems.push(item);
          }
          item.listPrice = rawPrice;
          variants.set(key, item);
        }
        row.costItemId = item.id;
        delete row.listPrice;
      }
    }
    // Products not used in any package still acquire a zero default.
    for (const item of project.costItems) item.listPrice = String(item.listPrice ?? '0');
    return project;
  }

  function normalizeState(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed.version === 1 || parsed.version === 2) &&
        Array.isArray(parsed.costItems) && Array.isArray(parsed.packages) && parsed.packages.length) {
      const project = normalizeProject({
        id: uid('proj'), name:'项目1', currentPackageId: parsed.currentPackageId,
        costItems: parsed.version === 1
          ? parsed.costItems.map(item => ({...item,type:'product',components:[]}))
          : parsed.costItems,
        packages: parsed.packages
      });
      migrateLegacyProductPrices(project);
      return {version:STATE_VERSION,currentProjectId:project.id,projects:[project]};
    }
    if (![3, STATE_VERSION].includes(parsed.version) ||
        !Array.isArray(parsed.projects) || !parsed.projects.length) return null;
    const projects = parsed.projects.map((project,index) => {
      const normalized = normalizeProject(project, `项目${index+1}`);
      if (parsed.version < STATE_VERSION) migrateLegacyProductPrices(normalized);
      return normalized;
    });
    const currentProjectId = projects.some(p=>p.id===parsed.currentProjectId)
      ? parsed.currentProjectId : projects[0].id;
    return {version:STATE_VERSION,currentProjectId,projects};
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return normalizeState(JSON.parse(raw)) || defaultState();
    } catch {
      return defaultState();
    }
  }

  // Initialize the editable workspace from the last saved browser snapshot.
  let migrationPending = (() => {
    try { const raw=localStorage.getItem(STORAGE_KEY); return !!raw && JSON.parse(raw).version < STATE_VERSION; }
    catch { return false; }
  })();
  let savedState = loadState();
  let state = clone(savedState);
  let dirty = migrationPending;

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      toast('保存失败：本机浏览器存储不可用，请先导出备份');
      return;
    }
    savedState = clone(state);
    migrationPending = false;
    dirty = false;
    updateSaveState();
    toast('已保存');
  }

  function markDirty() {
    dirty = true;
    updateSaveState();
  }

  function updateSaveState() {
    $('saveState').textContent = dirty ? (migrationPending ? '旧数据已兼容升级，请保存' : '有未保存的修改') : '已保存到本机';
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 1500);
  }

  function currentProject() {
    return state.projects.find(project => project.id === state.currentProjectId) || state.projects[0];
  }

  function currentPackage() {
    const project = currentProject();
    return project.packages.find(p => p.id === project.currentPackageId) || project.packages[0];
  }

  function costItem(id) {
    return currentProject().costItems.find(item => item.id === id);
  }

  function effectiveCostById(id, visiting = new Set()) {
    const item = costItem(id);
    if (!item) return 0n;
    if (item.type !== 'combo') return nonNegative(item.cost ?? '0');
    if (visiting.has(id)) return 0n;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);
    return (item.components || []).reduce((sum, component) => {
      if (!component.costItemId || component.costItemId === id) return sum;
      const componentCost = effectiveCostById(component.costItemId, nextVisiting);
      return add(sum, mul(componentCost, nonNegative(component.qty)));
    }, 0n);
  }

  function unitCost(row) {
    return effectiveCostById(row.costItemId);
  }

  function comboReferences(targetId) {
    return currentProject().costItems.some(item => item.type === 'combo' && (item.components || []).some(c => c.costItemId === targetId));
  }

  function wouldCreateCycle(comboId, candidateId) {
    if (!candidateId) return false;
    if (comboId === candidateId) return true;
    const seen = new Set();
    function reaches(id) {
      if (id === comboId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const item = costItem(id);
      if (!item || item.type !== 'combo') return false;
      return (item.components || []).some(c => c.costItemId && reaches(c.costItemId));
    }
    return reaches(candidateId);
  }

  function qty(row) {
    return nonNegative(row.qty);
  }

  function price(row) {
    return nonNegative(costItem(row.costItemId)?.listPrice ?? '0');
  }

  function discountFactor(discount) {
    return div(nonNegative(discount.zhe), parseDecimal('10'));
  }

  function feePercentFactor(fee) {
    return div(nonNegative(fee.value), parseDecimal('100'));
  }

  function originalSales(pkg) {
    return pkg.products.reduce((sum, row) => add(sum, mul(price(row), qty(row))), 0n);
  }

  function goodsCost(pkg) {
    return pkg.products.reduce((sum, row) => add(sum, mul(unitCost(row), qty(row))), 0n);
  }

  function fixedFees(pkg) {
    return pkg.fees.filter(f => f.type === 'fixed')
      .reduce((sum, fee) => add(sum, nonNegative(fee.value)), 0n);
  }

  function percentFeeRate(pkg) {
    return pkg.fees.filter(f => f.type === 'percent')
      .reduce((sum, fee) => add(sum, feePercentFactor(fee)), 0n);
  }

  function totalQty(pkg) {
    return pkg.products.reduce((sum, row) => add(sum, qty(row)), 0n);
  }

  function metrics(pkg, factor) {
    const sales = mul(originalSales(pkg), factor);
    const goods = goodsCost(pkg);
    const fixed = fixedFees(pkg);
    const variable = mul(sales, percentFeeRate(pkg));
    const total = goods + fixed + variable;
    const profit = sales - total;
    return {
      qty: totalQty(pkg),
      sales, goods, fixed, variable, total, profit,
      margin: sales === 0n ? 0n : div(profit, sales),
      costRate: sales === 0n ? 0n : div(total, sales)
    };
  }

  function productOptions(selectedId, currentRowId) {
    const selectedIds = new Set(currentPackage().products
      .filter(row => row.id !== currentRowId)
      .map(row => row.costItemId));
    return currentProject().costItems
      .filter(item => item.active || item.id === selectedId)
      .map(item => {
        const disabled = selectedIds.has(item.id) && item.id !== selectedId;
        const baseLabel = item.spec ? `${item.name} · ${item.spec}` : item.name;
        const label = item.type === 'combo' ? `[组合] ${baseLabel}` : baseLabel;
        return `<option value="${item.id}" ${item.id===selectedId?'selected':''} ${disabled?'disabled':''}>${escapeHtml(label)}</option>`;
      }).join('');
  }

  function renderProjectSelect() {
    $('projectSelect').innerHTML = state.projects
      .map(project => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('');
    $('projectSelect').value = state.currentProjectId;
  }

  function renderPackageSelect() {
    $('packageSelect').innerHTML = currentProject().packages
      .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    $('packageSelect').value = currentProject().currentPackageId;
  }

  function renderProducts() {
    const pkg = currentPackage();
    $('productHead').innerHTML = `
      <tr>
        <th rowspan="2" class="rank sticky s0">排序</th>
        <th rowspan="2" class="product-col sticky s1">产品品类</th>
        <th rowspan="2" class="qty-col sticky s2">产品数量</th>
        <th rowspan="2" class="money-col sticky s3">单品成本</th>
        <th rowspan="2" class="money-col sticky s4">成本小计</th>
        <th rowspan="2" class="money-col sticky s5">标价小计</th>
        <th rowspan="2" class="profit-col sticky s6">商品利润小计</th>
        ${pkg.discounts.map(d => `
          <th colspan="2" class="discount-group">
            <div class="rate-editor">
              <input class="discount-input" data-id="${d.id}" value="${escapeHtml(d.zhe)}" inputmode="decimal" />
              <span>折</span>
              <button class="delete-icon delete-discount" data-id="${d.id}" title="删除折扣">×</button>
            </div>
          </th>`).join('')}
        <th rowspan="2" class="compact-action">操作</th>
      </tr>
      <tr>
        ${pkg.discounts.map(() => `<th class="discount-sub money-col">折扣价</th><th class="discount-sub profit-col">商品利润小计</th>`).join('')}
      </tr>`;

    if (!pkg.products.length) {
      $('productBody').innerHTML = `<tr><td class="empty-cell" colspan="${8 + pkg.discounts.length*2}">暂无产品，请点击顶部“添加产品”。</td></tr>`;
      bindProductEvents();
      return;
    }

    $('productBody').innerHTML = pkg.products.map((row, index) => {
      const c = unitCost(row);
      const q = qty(row);
      const p = price(row);
      const costSubtotal = mul(c, q);
      const listSubtotal = mul(p, q);
      const profitSubtotal = listSubtotal - costSubtotal;
      return `<tr>
        <td class="rank sticky s0"><div class="cell center">${index+1}</div></td>
        <td class="product-col sticky s1">
          <select class="cell-select product-select" data-id="${row.id}">
            ${productOptions(row.costItemId, row.id)}
          </select>
        </td>
        <td class="qty-col sticky s2"><input class="cell-input qty-input" data-id="${row.id}" value="${escapeHtml(row.qty)}" inputmode="decimal" /></td>
        <td class="money-col auto sticky s3"><div class="cell">${unitMoney(c)}</div></td>
        <td class="money-col auto sticky s4"><div class="cell">${money(costSubtotal)}</div></td>
        <td class="money-col auto sticky s5"><div class="cell">${money(listSubtotal)}</div></td>
        <td class="profit-col auto sticky s6"><div class="cell ${profitSubtotal>=0n?'pos':'neg'}">${money(profitSubtotal)}</div></td>
        ${pkg.discounts.map(d => {
          const factor = discountFactor(d);
          const discountedPrice = mul(p, factor);
          const discountedProfit = mul(discountedPrice - c, q);
          return `<td class="money-col auto"><div class="cell">${money(discountedPrice)}</div></td>
                  <td class="profit-col auto"><div class="cell ${discountedProfit>=0n?'pos':'neg'}">${money(discountedProfit)}</div></td>`;
        }).join('')}
        <td class="compact-action"><div class="cell center"><button class="delete-icon delete-product" data-id="${row.id}" title="删除产品">×</button></div></td>
      </tr>`;
    }).join('');

    bindProductEvents();
  }

  function bindCommittedNumber(selector, commit) {
    document.querySelectorAll(selector).forEach(el => {
      el.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      };
      el.onchange = e => commit(e.currentTarget);
    });
  }

  function bindProductEvents() {
    document.querySelectorAll('.product-select').forEach(el => {
      el.onchange = e => {
        const row = currentPackage().products.find(r => r.id === e.currentTarget.dataset.id);
        if (!row) return;
        row.costItemId = e.currentTarget.value;
        markDirty(); renderAll();
      };
    });
    bindCommittedNumber('.qty-input', el => {
      const row = currentPackage().products.find(r => r.id === el.dataset.id);
      if (!row) return;
      row.qty = el.value;
      markDirty(); renderProducts(); renderFees(); renderSummary();
    });
    document.querySelectorAll('.delete-product').forEach(el => {
      el.onclick = e => {
        const pkg = currentPackage();
        pkg.products = pkg.products.filter(r => r.id !== e.currentTarget.dataset.id);
        markDirty(); renderAll();
      };
    });
    bindCommittedNumber('.discount-input', el => {
      const d = currentPackage().discounts.find(x => x.id === el.dataset.id);
      if (!d) return;
      d.zhe = el.value;
      markDirty(); renderProducts(); renderFees(); renderSummary();
    });
    document.querySelectorAll('.delete-discount').forEach(el => {
      el.onclick = e => {
        const pkg = currentPackage();
        pkg.discounts = pkg.discounts.filter(d => d.id !== e.currentTarget.dataset.id);
        markDirty(); renderAll();
      };
    });
  }

  function renderFees() {
    const pkg = currentPackage();
    const baseSales = originalSales(pkg);

    if (!pkg.fees.length) {
      $('feeBody').innerHTML = `<tr><td class="empty-cell" colspan="5">暂无附加成本，可添加包装、人工、运费、平台佣金等费用。</td></tr>`;
      return;
    }

    $('feeBody').innerHTML = pkg.fees.map(fee => {
      const preview = fee.type === 'fixed'
        ? nonNegative(fee.value)
        : mul(baseSales, feePercentFactor(fee));
      return `<tr>
        <td><input class="cell-input fee-name-input" data-id="${fee.id}" value="${escapeHtml(fee.name)}" /></td>
        <td>
          <select class="cell-select fee-type-select" data-id="${fee.id}">
            <option value="fixed" ${fee.type==='fixed'?'selected':''}>固定金额</option>
            <option value="percent" ${fee.type==='percent'?'selected':''}>售价百分比</option>
          </select>
        </td>
        <td>
          <div class="inline-value">
            <span>${fee.type==='fixed'?'¥':''}</span>
            <input class="cell-input fee-value-input" data-id="${fee.id}" value="${escapeHtml(fee.value)}" inputmode="decimal" />
            <span>${fee.type==='percent'?'%':''}</span>
          </div>
        </td>
        <td class="auto"><div class="cell">${money(preview)}</div></td>
        <td class="compact-action"><div class="cell center"><button class="delete-icon delete-fee" data-id="${fee.id}" title="删除费用">×</button></div></td>
      </tr>`;
    }).join('');

    document.querySelectorAll('.fee-name-input').forEach(el => {
      el.oninput = e => {
        const fee = pkg.fees.find(f => f.id === e.currentTarget.dataset.id);
        if (!fee) return;
        fee.name = e.currentTarget.value;
        markDirty();
      };
    });
    document.querySelectorAll('.fee-type-select').forEach(el => {
      el.onchange = e => {
        const fee = pkg.fees.find(f => f.id === e.currentTarget.dataset.id);
        if (!fee) return;
        fee.type = e.currentTarget.value;
        fee.value = '';
        markDirty(); renderFees(); renderSummary();
      };
    });
    bindCommittedNumber('.fee-value-input', el => {
      const fee = pkg.fees.find(f => f.id === el.dataset.id);
      if (!fee) return;
      fee.value = el.value;
      markDirty(); renderFees(); renderSummary();
    });
    document.querySelectorAll('.delete-fee').forEach(el => {
      el.onclick = e => {
        pkg.fees = pkg.fees.filter(f => f.id !== e.currentTarget.dataset.id);
        markDirty(); renderFees(); renderSummary();
      };
    });
  }

  function quantityP(amount) {
    return decimalString(amount, 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + 'P';
  }

  function updatePricingMetrics() {
    const pkg = currentPackage();
    if (!pkg) return;
    const basic = metrics(pkg, SCALE);
    $('metricPackageName').textContent = pkg.name;
    $('metricItemsCount').textContent = quantityP(basic.qty);
    $('metricTotalSales').textContent = money(basic.sales);
    $('metricProfit').textContent = money(basic.profit);
    $('metricProfit').classList.toggle('neg', basic.profit < 0n);
    $('metricProfit').classList.toggle('pos', basic.profit >= 0n);
  }

  function renderSummary() {
    const pkg = currentPackage();
    const schemes = [
      {label:'原价', factor:SCALE},
      ...pkg.discounts.map(d => ({label:`${d.zhe || '0'}折`, factor:discountFactor(d)}))
    ];
    const rows = [
      ['商品总数量','qty',quantityP,''],
      ['销售总额','sales',money,''],
      ['商品成本','goods',money,''],
      ['固定附加成本','fixed',money,''],
      ['售价比例费用','variable',money,''],
      ['完整成本','total',money,'summary-highlight'],
      ['套餐利润','profit',money,'summary-profit'],
      ['毛利率','margin',percent,'summary-profit'],
      ['成本率','costRate',percent,'']
    ];
    const values = schemes.map(s => metrics(pkg, s.factor));

    $('summaryHead').innerHTML = `<tr>
      <th class="summary-label">折扣方案</th>
      ${schemes.map((s,i)=>`<th class="summary-value ${i===0?'summary-original':'summary-discount'}">${escapeHtml(s.label)}</th>`).join('')}
    </tr>`;

    $('summaryBody').innerHTML = rows.map(([label,key,formatter,cls]) => `
      <tr class="${cls}">
        <td class="summary-label">${label}</td>
        ${values.map(v => {
          const val = v[key];
          const tone = (key==='profit'||key==='margin') ? (val>=0n?'pos':'neg') : '';
          return `<td class="summary-value ${tone}">${formatter(val)}</td>`;
        }).join('')}
      </tr>`).join('');
    updatePricingMetrics();
  }

  function componentOptions(combo, component) {
    const selectedElsewhere = new Set((combo.components || [])
      .filter(c => c.id !== component.id && c.costItemId)
      .map(c => c.costItemId));
    return currentProject().costItems
      .filter(item => item.id !== combo.id)
      .map(item => {
        const blocked = selectedElsewhere.has(item.id) || wouldCreateCycle(combo.id, item.id);
        const baseLabel = item.spec ? `${item.name} · ${item.spec}` : item.name;
        const label = item.type === 'combo' ? `[组合] ${baseLabel}` : baseLabel;
        return `<option value="${item.id}" ${item.id===component.costItemId?'selected':''} ${blocked && item.id!==component.costItemId?'disabled':''}>${escapeHtml(label)}</option>`;
      }).join('');
  }

  const expandedCombos = new Set();
  let productFilterText = '';
  let productFilterType = 'all';

  function renderCostItems() {
    if (!currentProject().costItems.length) {
      $('searchCount').textContent='显示 0 / 0';
      $('costBody').innerHTML = `<tr><td class="empty-cell" colspan="10">暂无产品信息，可添加普通产品，也可以创建由多个产品组成的组合。</td></tr>`;
      return;
    }

    const allItems = currentProject().costItems;
    const visibleItems=allItems.map((item,index)=>({item,index})).filter(({item}) => {
      if (productFilterType !== 'all' && item.type !== productFilterType) return false;
      if (!productFilterText) return true;
      return `${item.name} ${item.spec || ''}`.toLowerCase().includes(productFilterText);
    });
    $('searchCount').textContent = `显示 ${visibleItems.length} / ${allItems.length}`;
    if (!visibleItems.length) {
      $('costBody').innerHTML = '<tr><td class="empty-cell" colspan="10">没有符合条件的产品，可调整搜索词或筛选条件。</td></tr>';
      return;
    }
    $('costBody').innerHTML = visibleItems.map(({item,index}) => {
      const isCombo = item.type === 'combo';
      const components = Array.isArray(item.components) ? item.components : [];
      const expanded = expandedCombos.has(item.id);
      const compSummary = components.map(c => {
        const ref=costItem(c.costItemId);
        return `${ref ? ref.name : '待选择'} × ${c.qty}`;
      }).join(' · ');
      const costCell = isCombo
        ? `<div class="cell combo-cost">${unitMoney(effectiveCostById(item.id))}</div>`
        : `<div class="inline-value"><span>¥</span><input class="cell-input cost-value-input" data-id="${item.id}" value="${escapeHtml(item.cost)}" inputmode="decimal" /></div>`;
      const profit = nonNegative(item.listPrice) - effectiveCostById(item.id);
      const summaryCell = isCombo ? `<span class="combo-summary" title="${escapeHtml(compSummary)}">${escapeHtml(compSummary || '尚未添加成份')}</span>` : '<span class="slash-cell">—</span>';
      const memberCount = isCombo ? `${components.length} 项` : '—';
      const componentCell = components.map(component => `
        <div class="combo-component-row">
          <select class="component-select" data-item="${item.id}" data-component="${component.id}">
            <option value="">请选择成份</option>
            ${componentOptions(item, component)}
          </select>
          <label class="combo-component-quantity">数量 <input class="component-qty-input" data-item="${item.id}" data-component="${component.id}" value="${escapeHtml(component.qty)}" inputmode="decimal" /></label>
          <button class="component-remove" data-item="${item.id}" data-component="${component.id}" title="移除成份">×</button>
        </div>`).join('');
      const detail = isCombo && expanded ? `<tr class="combo-detail-row"><td colspan="10">
        <div class="combo-detail-inner">
          <div class="combo-detail-aside"><span class="combo-detail-caption">组合结构</span><strong>${escapeHtml(item.name)}</strong><span>引用产品成本自动汇总，不修改原有计算逻辑。</span></div>
          <div class="combo-editor-list">${componentCell}<button class="component-add add-component" data-item="${item.id}">＋ 添加成份</button></div>
        </div>
      </td></tr>` : '';
      return `<tr class="catalog-row ${isCombo ? 'catalog-combo-row' : ''}">
        <td class="rank"><div class="cell center muted-rank">${index+1}</div></td>
        <td>
          <div class="catalog-name-row">
            ${isCombo ? `<button class="combo-toggle ${expanded?'expanded':''}" data-item="${item.id}" aria-label="${expanded?'收起':'展开'}组合成份" aria-expanded="${expanded}">▸</button>` : '<span class="combo-toggle-spacer"></span>'}
            <input class="cell-input cost-name-input" data-id="${item.id}" value="${escapeHtml(item.name)}" />
            ${isCombo?'<span class="cost-kind">组合</span>':''}
          </div>
        </td>
        <td>${summaryCell}</td>
        <td><div class="cell center small-muted">${memberCount}</div></td>
        <td><input class="cell-input cost-spec-input" data-id="${item.id}" value="${escapeHtml(item.spec)}" /></td>
        <td class="${isCombo?'auto':''}">${costCell}</td>
        <td><div class="inline-value"><span>¥</span><input class="cell-input cost-list-price-input" data-id="${item.id}" value="${escapeHtml(item.listPrice)}" inputmode="decimal" /></div></td>
        <td class="auto"><div class="cell ${profit>=0n?'pos':'neg'}">${money(profit)}</div></td>
        <td><select class="cell-select cost-active-select" data-id="${item.id}"><option value="1" ${item.active?'selected':''}>启用</option><option value="0" ${!item.active?'selected':''}>停用</option></select></td>
        <td class="compact-action"><div class="cell center"><button class="delete-icon delete-cost-item" data-id="${item.id}" title="删除">×</button></div></td>
      </tr>${detail}`;
    }).join('');
    document.querySelectorAll('.combo-toggle').forEach(el => {
      el.onclick = e => {
        const id=e.currentTarget.dataset.item;
        if(expandedCombos.has(id))expandedCombos.delete(id); else expandedCombos.add(id);
        const scroller=el.closest('.table-scroll');
        const savedTop=scroller?.scrollTop||0;
        renderCostItems();
        const updated=$('costBody').closest('.table-scroll');
        if(updated)updated.scrollTop=savedTop;
      };
    });

    document.querySelectorAll('.cost-name-input').forEach(el => {
      el.oninput = e => {
        const item = costItem(e.currentTarget.dataset.id);
        if (!item) return;
        item.name = e.currentTarget.value;
        markDirty(); renderProducts();
      };
    });
    document.querySelectorAll('.cost-spec-input').forEach(el => {
      el.oninput = e => {
        const item = costItem(e.currentTarget.dataset.id);
        if (!item) return;
        item.spec = e.currentTarget.value;
        markDirty(); renderProducts();
      };
    });
    bindCommittedNumber('.cost-value-input', el => {
      const item = costItem(el.dataset.id);
      if (!item || item.type === 'combo') return;
      item.cost = el.value;
      markDirty(); renderCostItems(); renderProducts(); renderSummary();
    });
    bindCommittedNumber('.cost-list-price-input', el => {
      const item = costItem(el.dataset.id);
      if (!item) return;
      if (!validDecimal(el.value)) { toast('请输入不小于 0 的有效售价'); renderCostItems(); return; }
      item.listPrice = el.value;
      markDirty(); renderCostItems(); renderProducts(); renderFees(); renderSummary();
    });
    document.querySelectorAll('.cost-active-select').forEach(el => {
      el.onchange = e => {
        const item = costItem(e.currentTarget.dataset.id);
        if (!item) return;
        item.active = e.currentTarget.value === '1';
        markDirty(); renderProducts();
      };
    });
    document.querySelectorAll('.add-component').forEach(el => {
      el.onclick = e => {
        const combo = costItem(e.currentTarget.dataset.item);
        if (!combo || combo.type !== 'combo') return;
        const used = new Set((combo.components || []).map(c => c.costItemId).filter(Boolean));
        const candidate = currentProject().costItems.find(item => item.id !== combo.id && item.active && !used.has(item.id) && !wouldCreateCycle(combo.id, item.id));
        combo.components.push({id:uid('cmp'), costItemId:candidate?.id || '', qty:'1'});
        markDirty(); renderCostItems(); renderProducts(); renderSummary();
      };
    });
    document.querySelectorAll('.component-select').forEach(el => {
      el.onchange = e => {
        const combo = costItem(e.currentTarget.dataset.item);
        const component = combo?.components?.find(c => c.id === e.currentTarget.dataset.component);
        if (!combo || !component) return;
        const nextId = e.currentTarget.value;
        if (nextId && wouldCreateCycle(combo.id, nextId)) {
          toast('该选择会形成循环组合');
          renderCostItems();
          return;
        }
        component.costItemId = nextId;
        markDirty(); renderCostItems(); renderProducts(); renderSummary();
      };
    });
    bindCommittedNumber('.component-qty-input', el => {
      const combo = costItem(el.dataset.item);
      const component = combo?.components?.find(c => c.id === el.dataset.component);
      if (!component) return;
      component.qty = el.value;
      markDirty(); renderCostItems(); renderProducts(); renderSummary();
    });
    document.querySelectorAll('.component-remove').forEach(el => {
      el.onclick = e => {
        const combo = costItem(e.currentTarget.dataset.item);
        if (!combo) return;
        combo.components = (combo.components || []).filter(c => c.id !== e.currentTarget.dataset.component);
        markDirty(); renderCostItems(); renderProducts(); renderSummary();
      };
    });
    document.querySelectorAll('.delete-cost-item').forEach(el => {
      el.onclick = e => {
        const id = e.currentTarget.dataset.id;
        const usedByPackage = currentProject().packages.some(p => p.products.some(row => row.costItemId === id));
        const usedByCombo = comboReferences(id);
        if (usedByPackage || usedByCombo) {
          toast(usedByCombo ? '该项目已被组合引用，暂不能删除' : '该项目已被套餐使用，暂不能删除');
          return;
        }
        currentProject().costItems = currentProject().costItems.filter(item => item.id !== id);
        markDirty(); renderAll();
      };
    });
  }


  function duplicateProject(source) {
    const costIdMap = new Map();
    source.costItems.forEach(item => costIdMap.set(item.id, uid('cost')));

    const costItems = source.costItems.map(item => ({
      ...clone(item),
      id: costIdMap.get(item.id),
      components: (item.components || []).map(component => ({
        ...clone(component),
        id: uid('cmp'),
        costItemId: costIdMap.get(component.costItemId) || ''
      }))
    }));

    const packageIdMap = new Map();
    const packages = source.packages.map(pkg => {
      const newPackageId = uid('pkg');
      packageIdMap.set(pkg.id, newPackageId);
      return {
      ...clone(pkg),
      id: newPackageId,
      products: pkg.products.map(row => ({...clone(row), id:uid('row'), costItemId:costIdMap.get(row.costItemId) || ''})),
      discounts: pkg.discounts.map(discount => ({...clone(discount), id:uid('disc')})),
      fees: pkg.fees.map(fee => ({...clone(fee), id:uid('fee')}))
      };
    });

    return {
      id: uid('proj'),
      name: `${source.name} 副本`,
      currentPackageId: packageIdMap.get(source.currentPackageId) || packages[0]?.id || '',
      costItems,
      packages: packages.length ? packages : [createEmptyPackage()]
    };
  }

  function parseTsv(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.split('\t').map(cell => cell.trim()))
      .filter(row => row.some(cell => cell !== ''));
  }

  function parseSingleColumn(text) {
    const lines=String(text || '').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
    while (lines.length && lines[lines.length-1] === '') lines.pop();
    return lines.map(line => [line.trim()]);
  }

  function isHeaderRow(row, type) {
    const joined = row.join('|');
    if (type === 'products') return /产品品类|产品数量/.test(joined);
    if (type === 'fees') return /费用名称|计算方式|数值/.test(joined);
    return /产品品类|成份|单个成本|状态/.test(joined);
  }

  function batchCostLabel(item) {
    return item.spec ? `${item.name} · ${item.spec}` : item.name;
  }

  function findCostItemForBatch(label) {
    const project = currentProject();
    const normalized = String(label || '').trim();
    if (!normalized) return null;
    const exactLabel = project.costItems.filter(item => batchCostLabel(item) === normalized);
    if (exactLabel.length === 1) return exactLabel[0];
    const byName = project.costItems.filter(item => item.name === normalized);
    return byName.length === 1 ? byName[0] : null;
  }

  function normalizeStatus(value) {
    const v = String(value || '').trim().toLowerCase();
    return !['停用','否','0','false','disabled'].includes(v);
  }

  function serializeBatch(type) {
    const project = currentProject();
    const pkg = currentPackage();
    if (type === 'products') {
      const rows = [['产品品类','产品数量']];
      pkg.products.forEach(row => {
        const item = costItem(row.costItemId);
        rows.push([item ? batchCostLabel(item) : '', row.qty]);
      });
      return rows.map(row => row.join('\t')).join('\n');
    }
    if (type === 'fees') {
      const rows = [['费用名称','计算方式','数值']];
      pkg.fees.forEach(fee => rows.push([fee.name, fee.type === 'percent' ? '售价百分比' : '固定金额', fee.value]));
      return rows.map(row => row.join('\t')).join('\n');
    }

    const rows = [['产品品类','成份','成份数量','规格/备注','单个成本','单品标价','状态']];
    project.costItems.forEach(item => {
      if (item.type !== 'combo') {
        rows.push([item.name,'/','/',item.spec || '',item.cost || '0',item.listPrice || '0',item.active ? '启用' : '停用']);
        return;
      }
      const components = item.components || [];
      if (!components.length) {
        rows.push([item.name,'','',item.spec || '',decimalString(effectiveCostById(item.id),4),item.listPrice || '0',item.active ? '启用' : '停用']);
        return;
      }
      components.forEach((component,index) => {
        const source = costItem(component.costItemId);
        rows.push([
          index === 0 ? item.name : '',
          source ? batchCostLabel(source) : '',
          component.qty,
          index === 0 ? (item.spec || '') : '',
          index === 0 ? decimalString(effectiveCostById(item.id),4) : '',
          index === 0 ? (item.listPrice || '0') : '',
          index === 0 ? (item.active ? '启用' : '停用') : ''
        ]);
      });
    });
    return rows.map(row => row.join('\t')).join('\n');
  }

  // Paste changes are prepared against a clone, then committed once. Invalid rows
  // never leave half a pasted list in the live project.
  function validDecimal(input, positive = false) {
    const value = String(input ?? '').trim();
    if (!/^(?:\d+)(?:\.\d{1,6})?$/.test(value)) return false;
    return positive ? parseDecimal(value) > 0n : parseDecimal(value) >= 0n;
  }

  function validateStatus(value, rowNumber) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || ['启用','是','1','true','enabled'].includes(v)) return true;
    if (['停用','否','0','false','disabled'].includes(v)) return false;
    throw new Error(`第 ${rowNumber} 行：状态应为“启用”或“停用”`);
  }

  function findItemInProject(project, label) {
    const needle = String(label || '').trim();
    const exact = project.costItems.filter(item => batchCostLabel(item) === needle);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const named = project.costItems.filter(item => item.name === needle);
    return named.length === 1 ? named[0] : null;
  }

  function applyBatchProducts(rows, project) {
    const pkg = project.packages.find(p => p.id === project.currentPackageId);
    let applied = 0;
    rows.forEach((raw, index) => {
      const rowNumber = index + 1;
      let row = raw;
      if (/^\d+$/.test(row[0] || '') && row.length >= 4) row = row.slice(1);
      if (row.length > 3) throw new Error(`第 ${rowNumber} 行：套餐产品只需要产品品类和数量（旧版第三列标价仍兼容）`);
      const [label, quantity = '1', legacyPrice] = row;
      const item = findItemInProject(project, label);
      if (!item) throw new Error(`第 ${rowNumber} 行：找不到唯一的产品“${label}”，请检查名称或规格`);
      if (!item.active) throw new Error(`第 ${rowNumber} 行：产品“${label}”已停用`);
      if (!validDecimal(quantity || '1', true)) throw new Error(`第 ${rowNumber} 行：产品数量必须大于 0`);
      if (legacyPrice !== undefined && legacyPrice !== '') {
        if (!validDecimal(legacyPrice)) throw new Error(`第 ${rowNumber} 行：单品标价不是有效数字`);
        item.listPrice = legacyPrice;
      }
      const existing = pkg.products.find(p => p.costItemId === item.id);
      if (existing) existing.qty = quantity || '1';
      else pkg.products.push({id:uid('row'),costItemId:item.id,qty:quantity || '1'});
      applied++;
    });
    return applied;
  }

  function applyBatchFees(rows, project) {
    const pkg = project.packages.find(p => p.id === project.currentPackageId);
    let applied = 0;
    rows.forEach((row, index) => {
      const [name, method = '固定金额', value = '0'] = row;
      if (!name) throw new Error(`第 ${index + 1} 行：费用名称不能为空`);
      const normalizedMethod = String(method).trim().toLowerCase();
      const type = normalizedMethod === '固定金额' || normalizedMethod === 'fixed' ? 'fixed'
        : /^(售价百分比|成交价比例|percent|percentage|比例)$/.test(normalizedMethod) ? 'percent' : null;
      if (!type) throw new Error(`第 ${index + 1} 行：仅支持“固定金额”或“售价百分比”`);
      if (!validDecimal(value || '0')) throw new Error(`第 ${index + 1} 行：费用数值不是有效数字`);
      pkg.fees.push({id:uid('fee'),name,type,value:value || '0'});
      applied++;
    });
    return applied;
  }

  function parseCostColumns(raw, index) {
    let row = [...raw];
    if (/^\d+$/.test(row[0] || '') && row.length >= 7) row = row.slice(1);
    // Short table: Name / Cost / [List Price] / [Spec] / [Status]
    // Old short table: Name / Cost / [Spec] / [Status]
    if (row.length >= 2 && row.length <= 5 && validDecimal(row[1] || '')) {
      const hasPrice = row.length >= 3 && validDecimal(row[2] || '');
      return {
        name:row[0] || '',ingredient:'',qty:'',
        spec:hasPrice ? (row[3] || '') : (row[2] || ''),
        price:row[1],listPrice:hasPrice ? row[2] : '0',
        status:hasPrice ? (row[4] || '启用') : (row[3] || '启用'),
        rowNumber:index+1
      };
    }
    if (row.length < 6) throw new Error(`第 ${index+1} 行：产品信息请粘贴含售价的 7 列完整表，或旧版 6 列/简表`);
    if (row.length > 7) throw new Error(`第 ${index+1} 行：产品信息列数过多`);
    const isNew = row.length === 7;
    return {
      name:row[0] || '',ingredient:row[1] || '',qty:row[2] || '',
      spec:row[3] || '',price:row[4] || '',
      listPrice:isNew ? (row[5] || '') : '0',
      status:isNew ? (row[6] || '启用') : (row[5] || '启用'),rowNumber:index+1
    };
  }

  function applyBatchCost(rows, project) {
    const pendingCombos = [];
    const existingKeys = new Set(project.costItems.map(item => batchCostLabel(item)));
    let activeCombo = null;
    let applied = 0;
    rows.forEach((rawRow, index) => {
      const entry = parseCostColumns(rawRow, index);
      const name = String(entry.name).trim();
      const ingredient = String(entry.ingredient).trim();
      const hasIngredient = ingredient && ingredient !== '/';
      if (!name && activeCombo && hasIngredient) {
        if (!validDecimal(entry.qty || '1', true)) throw new Error(`第 ${entry.rowNumber} 行：成份数量必须大于 0`);
        activeCombo.pendingSpecs.push({label:ingredient,qty:entry.qty || '1',rowNumber:entry.rowNumber});
        return;
      }
      activeCombo = null;
      if (!name) throw new Error(`第 ${entry.rowNumber} 行：产品名称不能为空`);
      const spec = String(entry.spec || '').trim();
      const key = spec ? `${name} · ${spec}` : name;
      if (existingKeys.has(key)) throw new Error(`第 ${entry.rowNumber} 行：产品“${key}”已存在，请先修改名称/规格`);
      existingKeys.add(key);
      const enabled = validateStatus(entry.status, entry.rowNumber);
      if (hasIngredient) {
        if (!validDecimal(entry.qty || '1', true)) throw new Error(`第 ${entry.rowNumber} 行：成份数量必须大于 0`);
        const combo = {
          id:uid('cost'),type:'combo',name,spec,cost:'0',listPrice:'0',active:enabled,components:[],
          pendingSpecs:[{label:ingredient,qty:entry.qty || '1',rowNumber:entry.rowNumber}]
        };
        const listPrice = entry.listPrice || '0';
        if (!validDecimal(listPrice)) throw new Error(`第 ${entry.rowNumber} 行：单品标价不是有效数字`);
        combo.listPrice = listPrice;
        project.costItems.push(combo);
        pendingCombos.push(combo);
        activeCombo=combo;
      } else {
        const cost = entry.price || '0';
        if (!validDecimal(cost)) throw new Error(`第 ${entry.rowNumber} 行：单个成本不是有效数字`);
        const listPrice = entry.listPrice || '0';
        if (!validDecimal(listPrice)) throw new Error(`第 ${entry.rowNumber} 行：单品标价不是有效数字`);
        project.costItems.push({id:uid('cost'),type:'product',name,spec,cost,listPrice,active:enabled,components:[]});
      }
      applied++;
    });
    pendingCombos.forEach(combo => {
      combo.components = combo.pendingSpecs.map(spec => {
        const item = findItemInProject(project, spec.label);
        if (!item || item.id===combo.id) throw new Error(`第 ${spec.rowNumber} 行：成份“${spec.label}”不存在或名称不唯一`);
        return {id:uid('cmp'),costItemId:item.id,qty:spec.qty};
      });
      delete combo.pendingSpecs;
    });
    // Test the entire graph for cycles, including forward references within this paste.
    const byId = new Map(project.costItems.map(item => [item.id,item]));
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) throw new Error('组合成份出现循环引用，请修改后重新粘贴');
      if (visited.has(id)) return;
      visiting.add(id);
      const item=byId.get(id);
      if (item?.type==='combo') (item.components || []).forEach(c => visit(c.costItemId));
      visiting.delete(id);
      visited.add(id);
    }
    project.costItems.forEach(item => visit(item.id));
    return applied;
  }

  const batchColumns = {
    products: [{id:'product',label:'产品品类'}, {id:'qty',label:'产品数量'}],
    fees: [{id:'name',label:'费用名称'}, {id:'value',label:'费用数值'}, {id:'type',label:'计算方式'}],
    cost: [
      {id:'name',label:'产品品类'}, {id:'spec',label:'规格 / 备注'},
      {id:'cost',label:'单个成本'}, {id:'listPrice',label:'单品标价'},
      {id:'status',label:'状态'}
    ]
  };

  function applySingleColumn(project, type, field, values, startIndex=0) {
    if (!batchColumns[type]?.some(c=>c.id===field)) throw new Error('不支持的单列字段');
    const items = type==='cost' ? project.costItems : type==='fees'
      ? project.packages.find(p=>p.id===project.currentPackageId).fees
      : project.packages.find(p=>p.id===project.currentPackageId).products;
    if (!Array.isArray(items)) throw new Error('目标列表不存在');
    for (let n=0;n<values.length;n++) {
      const i=startIndex+n, val=String(values[n] ?? '').trim();
      const rowNo=i+1;
      if (type==='cost') {
        // Append new blank products only when pasting into an expandable product column.
        if (!items[i]) items.push({id:uid('cost'),type:'product',name:`新产品${rowNo}`,
          spec:'',cost:'0',listPrice:'0',active:true,components:[]});
        const item=items[i];
        if (field==='cost' && item.type==='combo') throw new Error(`第 ${rowNo} 行：组合成本自动计算，无法粘贴覆盖`);
        if (field==='cost' || field==='listPrice') {
          if (!validDecimal(val)) throw new Error(`第 ${rowNo} 行：请输入不小于 0 的有效数字`);
          item[field]=val;
        } else if (field==='status') item.active=validateStatus(val,rowNo);
        else if (field==='name') {
          if (!val) throw new Error(`第 ${rowNo} 行：产品名称不能为空`);
          item.name=val;
        } else item.spec=val;
      } else if(type==='products') {
        const pkg=project.packages.find(p=>p.id===project.currentPackageId);
        if (field==='product') {
          const match=findItemInProject(project,val);
          if (!match || !match.active) throw new Error(`第 ${rowNo} 行：未找到唯一的启用产品“${val}”`);
          if (pkg.products.some((r,k)=>k!==i && r.costItemId===match.id))
            throw new Error(`第 ${rowNo} 行：套餐内重复产品“${val}”`);
          if (!items[i]) items.push({id:uid('row'),costItemId:match.id,qty:'1'});
          else items[i].costItemId=match.id;
        } else {
          if (!items[i]) throw new Error(`第 ${rowNo} 行：没有产品行，请先添加产品或粘贴产品品类`);
          if (!validDecimal(val,true)) throw new Error(`第 ${rowNo} 行：产品数量必须大于 0`);
          items[i].qty=val;
        }
      } else {
        if (!items[i] && field!=='name') throw new Error(`第 ${rowNo} 行：没有费用行，请先添加费用`);
        if (!items[i]) items.push({id:uid('fee'),name:val,type:'fixed',value:'0'});
        if (field==='name') {
          if (!val) throw new Error(`第 ${rowNo} 行：费用名称不能为空`);
          items[i].name=val;
        } else if (field==='type') {
          const normalized=val.toLowerCase();
          if (normalized==='固定金额'||normalized==='fixed') items[i].type='fixed';
          else if (['售价百分比','成交价比例','percent','percentage'].includes(normalized)) items[i].type='percent';
          else throw new Error(`第 ${rowNo} 行：不支持的计算方式“${val}”`);
        } else {
          if (!validDecimal(val)) throw new Error(`第 ${rowNo} 行：费用数值无效`);
          items[i].value=val;
        }
      }
    }
    if (type==='cost' && (field==='name' || field==='spec')) {
      const ids=new Set();
      for (const item of items) {
        const key=batchCostLabel(item);
        if (ids.has(key)) throw new Error(`产品品类/规格重复：“${key}”`);
        ids.add(key);
      }
    }
    return values.length;
  }

  function serializeSingleColumn(type, field) {
    const pkg=currentPackage();
    const items=type==='cost'?currentProject().costItems:type==='fees'?pkg.fees:pkg.products;
    const options=batchColumns[type];
    const label=options.find(o=>o.id===field)?.label || '内容';
    const data=items.map(item=>{
      if (type==='cost') {
        if (field==='cost') return item.type==='combo'?decimalString(effectiveCostById(item.id),4):item.cost;
        if (field==='status') return item.active?'启用':'停用';
        return String(item[field]??'');
      }
      if (type==='fees') return field==='type'?(item.type==='percent'?'售价百分比':'固定金额'):String(item[field]??'');
      return field==='product'?batchCostLabel(costItem(item.costItemId) || {name:''}):String(item.qty??'');
    });
    return [label,...data].join('\n');
  }

  function renderBatchColumns() {
    const type=$('batchType').value;
    const select=$('batchColumn');
    const previous=select.value;
    select.innerHTML=batchColumns[type].map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
    if (batchColumns[type].some(c=>c.id===previous)) select.value=previous;
    $('batchColumnWrap').hidden=$('batchMode').value!=='column';
  }

  function updateBatchHint() {
    renderBatchColumns();
    const type=$('batchType').value;
    const mode=$('batchMode').value;
    if (mode==='column') {
      $('batchHint').textContent='仅粘贴一列，按当前列表从第 1 行向下批量填入；在实际表格输入框 Ctrl+V 可从该行开始填写。整个批次先校验，失败不改动数据。';
      return;
    }
    const hints={
      products:'列顺序：产品品类 ｜ 产品数量（兼容旧版第三列售价，自动写回产品信息设置）。产品名称需与当前项目的产品信息设置一致。',
      fees:'列顺序：费用名称 ｜ 计算方式 ｜ 数值。计算方式支持“固定金额”或“售价百分比”。',
      cost:'支持简表：产品名称 ｜ 单个成本 ｜ 单品标价 ｜ 规格/备注 ｜ 状态；或完整表：产品品类 ｜ 成份 ｜ 成份数量 ｜ 规格/备注 ｜ 单个成本 ｜ 单品标价 ｜ 状态。兼容旧版缺少单品标价的表。'
    };
    $('batchHint').textContent=hints[type];
  }

  function showBatchError(message) {
    $('batchError').hidden=false;
    $('batchError').textContent=message;
  }

  function openBatchModal(type) {
    $('batchType').value = type;
    $('batchText').value = '';
    $('batchMode').value='table';
    $('batchError').hidden=true;
    updateBatchHint();
    $('batchModal').hidden = false;
    setTimeout(() => $('batchText').focus(), 0);
  }

  function closeBatchModal() {
    $('batchModal').hidden = true;
    $('batchError').hidden=true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      $('batchText').focus();
      $('batchText').select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }

  function enableVerticalScrollHandoff() {
    document.querySelectorAll('.table-scroll, .summary-scroll').forEach(scroller => {
      if (scroller.dataset.scrollHandoff === '1') return;
      scroller.dataset.scrollHandoff = '1';

      scroller.addEventListener('wheel', event => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

        const atTop = scroller.scrollTop <= 0;
        const atBottom = Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 1;
        const leavingTop = event.deltaY < 0 && atTop;
        const leavingBottom = event.deltaY > 0 && atBottom;

        if (leavingTop || leavingBottom) {
          event.preventDefault();
          window.scrollBy({ top: event.deltaY, left: 0, behavior: 'auto' });
        }
      }, { passive: false });
    });
  }

  function renderAll() {
    renderProjectSelect();
    renderPackageSelect();
    renderProducts();
    renderFees();
    renderSummary();
    renderCostItems();
    updateSaveState();
    renderV8Context();
    enableVerticalScrollHandoff();
  }

  function renderV8Context() {
    const project=currentProject();
    const pkg=currentPackage();
    const all=project.costItems;
    $('sidebarProjectName').textContent=project.name;
    $('statProductCount').textContent=all.length;
    $('statComboCount').textContent=all.filter(i=>i.type==='combo').length;
    $('statActiveCount').textContent=all.filter(i=>i.active).length;
    updatePricingMetrics();
  }
  function selectV8View(next) {
    const pricing = next==='pricing';
    document.querySelectorAll('.mobile-view-tab').forEach(x=>x.classList.toggle('active',x.dataset.view===next));
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.nav===next));
    $('pricingView').classList.toggle('active', pricing);
    $('costView').classList.toggle('active', !pricing);
    $('viewTitle').textContent=pricing?'套餐售价计算':'产品信息设置';
    $('breadcrumbCurrent').textContent=pricing?'售价计算':'产品管理';
    $('viewSubtitle').textContent=pricing?'选择套餐，对比成本、折扣与最终利润。':'维护产品、组合与基础定价，成本变化自动传递到套餐。';
    window.scrollTo({top:0,behavior:'instant'});
  }

  $('projectSelect').onchange = e => {
    state.currentProjectId = e.currentTarget.value;
    markDirty();
    renderAll();
  };

  $('newProjectBtn').onclick = () => {
    const name = prompt('请输入项目名称');
    if (!name?.trim()) return;
    const project = createEmptyProject(name.trim());
    state.projects.push(project);
    state.currentProjectId = project.id;
    markDirty(); renderAll();
  };

  $('copyProjectBtn').onclick = () => {
    const copy = duplicateProject(currentProject());
    state.projects.push(copy);
    state.currentProjectId = copy.id;
    markDirty(); renderAll();
  };

  $('renameProjectBtn').onclick = () => {
    const project = currentProject();
    const name = prompt('修改项目名称', project.name);
    if (!name?.trim()) return;
    project.name = name.trim();
    markDirty(); renderAll();
  };

  $('deleteProjectBtn').onclick = () => {
    if (state.projects.length <= 1) { toast('至少保留一个项目'); return; }
    const project = currentProject();
    if (!confirm(`确定删除项目“${project.name}”及其全部套餐数据吗？`)) return;
    state.projects = state.projects.filter(item => item.id !== project.id);
    state.currentProjectId = state.projects[0].id;
    markDirty(); renderAll();
  };

  $('packageSelect').onchange = e => {
    currentProject().currentPackageId = e.currentTarget.value;
    markDirty(); renderAll();
  };

  $('addCostItemBtn').onclick = () => {
    currentProject().costItems.push({id:uid('cost'),type:'product',name:'新产品',spec:'',cost:'0',listPrice:'0',active:true,components:[]});
    markDirty(); renderAll();
  };

  $('addComboItemBtn').onclick = () => {
    const first = currentProject().costItems.find(item => item.active);
    currentProject().costItems.push({
      id:uid('cost'),
      type:'combo',
      name:'新组合',
      spec:'',
      cost:'0',
      listPrice:'0',
      active:true,
      components:first ? [{id:uid('cmp'),costItemId:first.id,qty:'1'}] : []
    });
    markDirty(); renderAll();
  };

  $('addProductBtn').onclick = () => {
    const pkg = currentPackage();
    const selected = new Set(pkg.products.map(r => r.costItemId));
    const first = currentProject().costItems.find(item => item.active && !selected.has(item.id));
    if (!first) {
      toast(currentProject().costItems.length ? '没有可继续添加的启用产品' : '请先在产品信息设置中添加产品');
      return;
    }
    pkg.products.push({id:uid('row'),costItemId:first.id,qty:'1'});
    markDirty(); renderAll();
    requestAnimationFrame(()=> $('productScroll').scrollTop = $('productScroll').scrollHeight);
  };

  $('addFeeBtn').onclick = () => {
    currentPackage().fees.push({id:uid('fee'),name:'其他费用',type:'fixed',value:'0'});
    markDirty(); renderFees(); renderSummary();
  };

  $('addDiscountBtn').onclick = () => {
    currentPackage().discounts.push({id:uid('disc'),zhe:'9'});
    markDirty(); renderAll();
    requestAnimationFrame(()=> $('productScroll').scrollLeft = $('productScroll').scrollWidth);
  };

  $('newPackageBtn').onclick = () => {
    const name = prompt('请输入套餐名称');
    if (!name?.trim()) return;
    const id = uid('pkg');
    currentProject().packages.push({
      id, name:name.trim(), products:[],
      discounts:[{id:uid('disc'),zhe:'7'},{id:uid('disc'),zhe:'8'},{id:uid('disc'),zhe:'8.5'}],
      fees:[]
    });
    currentProject().currentPackageId = id;
    markDirty(); renderAll();
  };

  $('copyPackageBtn').onclick = () => {
    const source = currentPackage();
    const copy = clone(source);
    copy.id = uid('pkg');
    copy.name = `${source.name} 副本`;
    copy.products = copy.products.map(row => ({...row,id:uid('row')}));
    copy.discounts = copy.discounts.map(d => ({...d,id:uid('disc')}));
    copy.fees = copy.fees.map(f => ({...f,id:uid('fee')}));
    currentProject().packages.push(copy);
    currentProject().currentPackageId = copy.id;
    markDirty(); renderAll();
  };

  $('renamePackageBtn').onclick = () => {
    const p = currentPackage();
    const name = prompt('修改套餐名称', p.name);
    if (!name?.trim()) return;
    p.name = name.trim();
    markDirty(); renderAll();
  };

  $('deletePackageBtn').onclick = () => {
    if (currentProject().packages.length <= 1) {
      toast('至少保留一个套餐');
      return;
    }
    const p = currentPackage();
    if (!confirm(`确定删除套餐“${p.name}”吗？`)) return;
    currentProject().packages = currentProject().packages.filter(x => x.id !== p.id);
    currentProject().currentPackageId = currentProject().packages[0].id;
    markDirty(); renderAll();
  };

  document.addEventListener('paste', event => {
    const target=event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const text=event.clipboardData?.getData('text/plain') || '';
    if (!/[\t\r\n]/.test(text)) return;
    const section=target.closest('#costView')?'cost'
      :target.closest('.fees-block')?'fees'
      :target.closest('.products-block')?'products':null;
    if (!section) return;
    event.preventDefault();
    // Multi-column TSV still opens the original preview + apply dialog.
    if (text.includes('\t')) {
      openBatchModal(section);
      $('batchText').value=text;
      return;
    }
    const cls={
      'cost-name-input':'name','cost-spec-input':'spec','cost-value-input':'cost',
      'cost-list-price-input':'listPrice','qty-input':'qty',
      'fee-name-input':'name','fee-value-input':'value'
    };
    const matched=Object.entries(cls).find(([key])=>target.classList.contains(key));
    if (!matched) { openBatchModal(section);$('batchText').value=text;return; }
    let rows=parseSingleColumn(text);
    if (!rows.length) return;
    const field=matched[1];
    const expected=batchColumns[section]?.find(c=>c.id===field)?.label;
    if (expected && rows[0]?.[0]===expected) rows=rows.slice(1);
    if (!rows.length) return;
    const project=clone(currentProject());
    const pkg=project.packages.find(p=>p.id===project.currentPackageId);
    const entries=section==='cost'?project.costItems:section==='fees'?pkg.fees:pkg.products;
    const start=entries.findIndex(r=>r.id===target.dataset.id);
    if(start<0) return;
    try {
      const count=applySingleColumn(project,section,field,rows.map(row=>row[0]),start);
      const idx=state.projects.findIndex(p=>p.id===project.id);
      state.projects[idx]=project;
      markDirty();renderAll();toast(`已粘贴 ${count} 行，请保存`);
    } catch(err) {
      openBatchModal(section);
      $('batchMode').value='column';
      updateBatchHint();
      $('batchColumn').value=field;
      $('batchText').value=text;
      showBatchError(`${err.message}（本次粘贴未应用任何行）`);
    }
  });

  $('batchPricingBtn').onclick = () => openBatchModal('products');
  $('batchCostBtn').onclick = () => openBatchModal('cost');
  $('closeBatchBtn').onclick = closeBatchModal;
  $('cancelBatchBtn').onclick = closeBatchModal;
  $('batchType').onchange = () => { $('batchError').hidden=true;updateBatchHint(); };
  $('batchMode').onchange = () => { $('batchError').hidden=true;updateBatchHint(); };
  $('batchColumn').onchange = () => { $('batchError').hidden=true; };
  $('batchText').oninput = () => { $('batchError').hidden=true; };
  document.addEventListener('keydown', event => {
    if (event.key==='Escape' && !$('batchModal').hidden) closeBatchModal();
  });
  $('batchModal').onclick = e => { if (e.target === $('batchModal')) closeBatchModal(); };
  $('copyBatchBtn').onclick = async () => {
    const text = $('batchMode').value === 'column'
      ? serializeSingleColumn($('batchType').value,$('batchColumn').value)
      : serializeBatch($('batchType').value);
    $('batchText').value = text;
    const ok = await copyText(text);
    toast(ok ? '当前数据已复制' : '已生成多行数据，请手动复制');
  };
  $('applyBatchBtn').onclick = () => {
    const type=$('batchType').value, mode=$('batchMode').value;
    let rows=mode==='column' ? parseSingleColumn($('batchText').value) : parseTsv($('batchText').value);
    if (!rows.length) { showBatchError('请先粘贴数据'); return; }
    if (mode==='column') {
      if (rows.some(r=>r.length!==1)) { showBatchError('单列模式只能粘贴一列，请切换到整表多列模式'); return; }
      const header=batchColumns[type].find(c=>c.id===$('batchColumn').value)?.label;
      if (rows[0]?.[0]===header) rows=rows.slice(1);
    } else if (isHeaderRow(rows[0],type)) rows=rows.slice(1);
    if (!rows.length) { showBatchError('表头下没有数据行'); return; }
    try {
      const project=clone(currentProject());
      const applied=mode==='column'
        ? applySingleColumn(project,type,$('batchColumn').value,rows.map(r=>r[0]))
        :type==='products'?applyBatchProducts(rows,project)
        :type==='fees'?applyBatchFees(rows,project):applyBatchCost(rows,project);
      const idx=state.projects.findIndex(p=>p.id===project.id);
      if(idx<0) throw new Error('当前项目不存在');
      state.projects[idx]=project;
      markDirty();renderAll();closeBatchModal();toast(`已应用 ${applied} 行，请保存`);
    } catch(err) {
      showBatchError(err instanceof Error?err.message:'数据解析失败');
    }
  };

  $('saveBtn').onclick = persist;

  $('resetBtn').onclick = () => {
    if (!dirty) return;
    if (!confirm('放弃当前未保存的修改？')) return;
    state = clone(savedState);
    dirty = false;
    renderAll();
    toast('已恢复到上次保存状态');
  };

  $('backupBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Dopamine_Pricing_Backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  };

  $('restoreBtn').onclick = () => $('restoreInput').click();

  $('restoreInput').onchange = async e => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      const parsed = normalizeState(JSON.parse(await file.text()));
      if (!parsed) throw new Error('invalid');
      if (!confirm('恢复备份会替换当前页面中的数据，是否继续？')) return;
      state = parsed;
      if (!currentProject().packages.some(p => p.id === currentProject().currentPackageId)) currentProject().currentPackageId = currentProject().packages[0].id;
      markDirty();
      renderAll();
      toast('备份已载入，请确认后保存');
    } catch {
      toast('备份文件无效');
    }
  };

  document.querySelectorAll('.mobile-view-tab').forEach(tab=>{
    tab.onclick=()=>selectV8View(tab.dataset.view);
  });
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.onclick=()=>selectV8View(btn.dataset.nav);
  });
  $('productSearch').oninput=e=>{
    productFilterText=e.currentTarget.value.toLowerCase().trim();
    renderCostItems();
  };
  $('productFilter').onchange=e=>{
    productFilterType=e.currentTarget.value;
    renderCostItems();
  };
  $('sidebarCollapse').onclick=()=>{
    document.documentElement.classList.toggle('sidebar-manual-collapse');
  };
  document.addEventListener('click',e=>{
    for(const el of document.querySelectorAll('.dropdown[open]')){
      if(!el.contains(e.target))el.removeAttribute('open');
    }
  });

  window.addEventListener('beforeunload', e => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  renderAll();
  selectV8View('cost');
})();
