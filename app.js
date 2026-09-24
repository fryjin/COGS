
(() => {
  'use strict';

  const STORAGE_KEY = 'dopamine-pricing-web-v1';
  const STATE_VERSION = 2;
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

  function defaultState() {
    const packageId = uid('pkg');
    return {
      version: STATE_VERSION,
      currentPackageId: packageId,
      costItems: [],
      packages: [{
        id: packageId,
        name: '套餐1',
        products: [],
        discounts: [
          {id: uid('disc'), zhe: '7'},
          {id: uid('disc'), zhe: '8'},
          {id: uid('disc'), zhe: '8.5'}
        ],
        fees: []
      }]
    };
  }

  let savedState = loadState();
  let state = clone(savedState);
  let dirty = false;

  function normalizeState(parsed) {
    if (!parsed || !Array.isArray(parsed.costItems) || !Array.isArray(parsed.packages) || !parsed.packages.length) return null;
    if (parsed.version === 1) {
      parsed = clone(parsed);
      parsed.version = STATE_VERSION;
      parsed.costItems = parsed.costItems.map(item => ({
        ...item,
        type: 'product',
        components: []
      }));
      return parsed;
    }
    if (parsed.version !== STATE_VERSION) return null;
    parsed = clone(parsed);
    parsed.costItems = parsed.costItems.map(item => ({
      ...item,
      type: item.type === 'combo' ? 'combo' : 'product',
      components: Array.isArray(item.components) ? item.components : []
    }));
    return parsed;
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

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    savedState = clone(state);
    dirty = false;
    updateSaveState();
    toast('已保存');
  }

  function markDirty() {
    dirty = true;
    updateSaveState();
  }

  function updateSaveState() {
    $('saveState').textContent = dirty ? '有未保存的修改' : '已保存到本机';
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 1500);
  }

  function currentPackage() {
    return state.packages.find(p => p.id === state.currentPackageId) || state.packages[0];
  }

  function costItem(id) {
    return state.costItems.find(item => item.id === id);
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
    return state.costItems.some(item => item.type === 'combo' && (item.components || []).some(c => c.costItemId === targetId));
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
    return nonNegative(row.listPrice);
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
    return state.costItems
      .filter(item => item.active || item.id === selectedId)
      .map(item => {
        const disabled = selectedIds.has(item.id) && item.id !== selectedId;
        const baseLabel = item.spec ? `${item.name} · ${item.spec}` : item.name;
        const label = item.type === 'combo' ? `[组合] ${baseLabel}` : baseLabel;
        return `<option value="${item.id}" ${item.id===selectedId?'selected':''} ${disabled?'disabled':''}>${escapeHtml(label)}</option>`;
      }).join('');
  }

  function renderPackageSelect() {
    $('packageSelect').innerHTML = state.packages
      .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    $('packageSelect').value = state.currentPackageId;
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
        <th rowspan="2" class="money-col sticky s5">单品标价</th>
        <th rowspan="2" class="money-col sticky s6">单品利润</th>
        <th rowspan="2" class="money-col sticky s7">标价小计</th>
        <th rowspan="2" class="profit-col sticky s8">商品利润小计</th>
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
      $('productBody').innerHTML = `<tr><td class="empty-cell" colspan="${10 + pkg.discounts.length*2}">暂无产品，请点击下方“添加产品”。</td></tr>`;
      bindProductEvents();
      return;
    }

    $('productBody').innerHTML = pkg.products.map((row, index) => {
      const c = unitCost(row);
      const q = qty(row);
      const p = price(row);
      const costSubtotal = mul(c, q);
      const unitProfit = p - c;
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
        <td class="money-col sticky s5"><input class="cell-input price-input" data-id="${row.id}" value="${escapeHtml(row.listPrice)}" inputmode="decimal" /></td>
        <td class="money-col auto sticky s6"><div class="cell ${unitProfit>=0n?'pos':'neg'}">${money(unitProfit)}</div></td>
        <td class="money-col auto sticky s7"><div class="cell">${money(listSubtotal)}</div></td>
        <td class="profit-col auto sticky s8"><div class="cell ${profitSubtotal>=0n?'pos':'neg'}">${money(profitSubtotal)}</div></td>
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

  function bindProductEvents() {
    document.querySelectorAll('.product-select').forEach(el => {
      el.onchange = e => {
        const row = currentPackage().products.find(r => r.id === e.currentTarget.dataset.id);
        if (!row) return;
        row.costItemId = e.currentTarget.value;
        markDirty(); renderAll();
      };
    });
    document.querySelectorAll('.qty-input').forEach(el => {
      el.oninput = e => {
        const row = currentPackage().products.find(r => r.id === e.currentTarget.dataset.id);
        if (!row) return;
        row.qty = e.currentTarget.value;
        markDirty(); renderProducts(); renderFees(); renderSummary();
      };
    });
    document.querySelectorAll('.price-input').forEach(el => {
      el.oninput = e => {
        const row = currentPackage().products.find(r => r.id === e.currentTarget.dataset.id);
        if (!row) return;
        row.listPrice = e.currentTarget.value;
        markDirty(); renderProducts(); renderFees(); renderSummary();
      };
    });
    document.querySelectorAll('.delete-product').forEach(el => {
      el.onclick = e => {
        const pkg = currentPackage();
        pkg.products = pkg.products.filter(r => r.id !== e.currentTarget.dataset.id);
        markDirty(); renderAll();
      };
    });
    document.querySelectorAll('.discount-input').forEach(el => {
      el.oninput = e => {
        const d = currentPackage().discounts.find(x => x.id === e.currentTarget.dataset.id);
        if (!d) return;
        d.zhe = e.currentTarget.value;
        markDirty(); renderProducts(); renderFees(); renderSummary();
      };
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
    document.querySelectorAll('.fee-value-input').forEach(el => {
      el.oninput = e => {
        const fee = pkg.fees.find(f => f.id === e.currentTarget.dataset.id);
        if (!fee) return;
        fee.value = e.currentTarget.value;
        markDirty(); renderFees(); renderSummary();
      };
    });
    document.querySelectorAll('.delete-fee').forEach(el => {
      el.onclick = e => {
        pkg.fees = pkg.fees.filter(f => f.id !== e.currentTarget.dataset.id);
        markDirty(); renderFees(); renderSummary();
      };
    });
  }

  function renderSummary() {
    const pkg = currentPackage();
    const schemes = [
      {label:'原价', factor:SCALE},
      ...pkg.discounts.map(d => ({label:`${d.zhe || '0'}折`, factor:discountFactor(d)}))
    ];
    const rows = [
      ['商品总数量','qty',x=>decimalString(x,2),''],
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
      <th class="summary-label">指标</th>
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
  }

  function componentOptions(combo, component) {
    const selectedElsewhere = new Set((combo.components || [])
      .filter(c => c.id !== component.id && c.costItemId)
      .map(c => c.costItemId));
    return state.costItems
      .filter(item => item.id !== combo.id)
      .map(item => {
        const blocked = selectedElsewhere.has(item.id) || wouldCreateCycle(combo.id, item.id);
        const baseLabel = item.spec ? `${item.name} · ${item.spec}` : item.name;
        const label = item.type === 'combo' ? `[组合] ${baseLabel}` : baseLabel;
        return `<option value="${item.id}" ${item.id===component.costItemId?'selected':''} ${blocked && item.id!==component.costItemId?'disabled':''}>${escapeHtml(label)}</option>`;
      }).join('');
  }

  function renderCostItems() {
    if (!state.costItems.length) {
      $('costBody').innerHTML = `<tr><td class="empty-cell" colspan="8">暂无固定成本产品，可添加普通产品，也可以创建由多个产品组成的组合。</td></tr>`;
      return;
    }

    $('costBody').innerHTML = state.costItems.map((item,index) => {
      const isCombo = item.type === 'combo';
      const components = Array.isArray(item.components) ? item.components : [];
      const componentCell = isCombo ? `
        <div class="component-stack">
          ${components.map(component => `
            <div class="component-line">
              <select class="component-select" data-item="${item.id}" data-component="${component.id}">
                <option value="">请选择成份</option>
                ${componentOptions(item, component)}
              </select>
              <button class="component-remove" data-item="${item.id}" data-component="${component.id}" title="删除成份">×</button>
            </div>`).join('')}
          <button class="component-add add-component" data-item="${item.id}">＋ 添加成份</button>
        </div>` : `<div class="cell center slash-cell">/</div>`;
      const quantityCell = isCombo ? `
        <div class="component-qty-stack">
          ${components.map(component => `
            <div class="component-line">
              <input class="component-qty-input" data-item="${item.id}" data-component="${component.id}" value="${escapeHtml(component.qty)}" inputmode="decimal" />
            </div>`).join('')}
        </div>` : `<div class="cell center slash-cell">/</div>`;
      const costCell = isCombo
        ? `<div class="cell combo-cost">${unitMoney(effectiveCostById(item.id))}</div>`
        : `<div class="inline-value"><span>¥</span><input class="cell-input cost-value-input" data-id="${item.id}" value="${escapeHtml(item.cost)}" inputmode="decimal" /></div>`;

      return `<tr class="${isCombo?'cost-row-combo':''}">
        <td class="rank"><div class="cell center">${index+1}</div></td>
        <td>
          <div style="display:flex;align-items:center;height:35px">
            <input class="cell-input cost-name-input" data-id="${item.id}" value="${escapeHtml(item.name)}" />
            ${isCombo?'<span class="cost-kind">组合</span>':''}
          </div>
        </td>
        <td>${componentCell}</td>
        <td>${quantityCell}</td>
        <td><input class="cell-input cost-spec-input" data-id="${item.id}" value="${escapeHtml(item.spec)}" /></td>
        <td class="${isCombo?'auto':''}">${costCell}</td>
        <td>
          <select class="cell-select cost-active-select" data-id="${item.id}">
            <option value="1" ${item.active?'selected':''}>启用</option>
            <option value="0" ${!item.active?'selected':''}>停用</option>
          </select>
        </td>
        <td class="compact-action"><div class="cell center"><button class="delete-icon delete-cost-item" data-id="${item.id}" title="删除">×</button></div></td>
      </tr>`;
    }).join('');

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
    document.querySelectorAll('.cost-value-input').forEach(el => {
      el.oninput = e => {
        const item = costItem(e.currentTarget.dataset.id);
        if (!item || item.type === 'combo') return;
        item.cost = e.currentTarget.value;
        markDirty(); renderCostItems(); renderProducts(); renderSummary();
      };
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
        const candidate = state.costItems.find(item => item.id !== combo.id && item.active && !used.has(item.id) && !wouldCreateCycle(combo.id, item.id));
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
    document.querySelectorAll('.component-qty-input').forEach(el => {
      el.oninput = e => {
        const combo = costItem(e.currentTarget.dataset.item);
        const component = combo?.components?.find(c => c.id === e.currentTarget.dataset.component);
        if (!component) return;
        component.qty = e.currentTarget.value;
        markDirty(); renderCostItems(); renderProducts(); renderSummary();
      };
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
        const usedByPackage = state.packages.some(p => p.products.some(row => row.costItemId === id));
        const usedByCombo = comboReferences(id);
        if (usedByPackage || usedByCombo) {
          toast(usedByCombo ? '该项目已被组合引用，暂不能删除' : '该项目已被套餐使用，暂不能删除');
          return;
        }
        state.costItems = state.costItems.filter(item => item.id !== id);
        markDirty(); renderAll();
      };
    });
  }

  function renderAll() {
    renderPackageSelect();
    renderProducts();
    renderFees();
    renderSummary();
    renderCostItems();
    updateSaveState();
  }

  $('packageSelect').onchange = e => {
    state.currentPackageId = e.currentTarget.value;
    markDirty(); renderAll();
  };

  $('addCostItemBtn').onclick = () => {
    state.costItems.push({id:uid('cost'),type:'product',name:'新产品',spec:'',cost:'0',active:true,components:[]});
    markDirty(); renderAll();
  };

  $('addComboItemBtn').onclick = () => {
    const first = state.costItems.find(item => item.active);
    state.costItems.push({
      id:uid('cost'),
      type:'combo',
      name:'新组合',
      spec:'',
      cost:'0',
      active:true,
      components:first ? [{id:uid('cmp'),costItemId:first.id,qty:'1'}] : []
    });
    markDirty(); renderAll();
  };

  $('addProductBtn').onclick = () => {
    const pkg = currentPackage();
    const selected = new Set(pkg.products.map(r => r.costItemId));
    const first = state.costItems.find(item => item.active && !selected.has(item.id));
    if (!first) {
      toast(state.costItems.length ? '没有可继续添加的启用产品' : '请先在固定成本管理中添加产品');
      return;
    }
    pkg.products.push({id:uid('row'),costItemId:first.id,qty:'1',listPrice:'0'});
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
    state.packages.push({
      id, name:name.trim(), products:[],
      discounts:[{id:uid('disc'),zhe:'7'},{id:uid('disc'),zhe:'8'},{id:uid('disc'),zhe:'8.5'}],
      fees:[]
    });
    state.currentPackageId = id;
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
    state.packages.push(copy);
    state.currentPackageId = copy.id;
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
    if (state.packages.length <= 1) {
      toast('至少保留一个套餐');
      return;
    }
    const p = currentPackage();
    if (!confirm(`确定删除套餐“${p.name}”吗？`)) return;
    state.packages = state.packages.filter(x => x.id !== p.id);
    state.currentPackageId = state.packages[0].id;
    markDirty(); renderAll();
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
      if (!state.packages.some(p => p.id === state.currentPackageId)) state.currentPackageId = state.packages[0].id;
      markDirty();
      renderAll();
      toast('备份已载入，请确认后保存');
    } catch {
      toast('备份文件无效');
    }
  };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      tab.classList.add('active');
      const pricing = tab.dataset.view === 'pricing';
      $('pricingView').classList.toggle('active', pricing);
      $('costView').classList.toggle('active', !pricing);
    };
  });

  window.addEventListener('beforeunload', e => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  renderAll();
})();
