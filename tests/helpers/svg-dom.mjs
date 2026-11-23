const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let viewport = { width: 1800, height: 1050 };
const glyphs = { ' ': .32, '\u00a0': .32, '1': .6, ',': .3, '.': .3 };
const fontSizes = {
  'node-title':17,'node-subtitle':14,'node-english':14,'node-building':15,'node-building-en':14,
  'node-rate':22,'node-machines':30,'compact-machines':40,'compact-title':19,'compact-secondary':13,
  'compact-total':34,'node-unit':14,'node-kind':14,'port-name':14,'port-rate':26,'port-unit':12,
  'label-title':17,'label-en':12,'label-rate':32,'label-unit':13,'label-transport':13,'summary-rate':26,
};

export class Element {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = {};
    this.children = [];
    this.events = {};
    this.style = {};
    this.parent = null;
    this._text = '';
    this.classList = {
      contains: name => (this.attrs.class || '').split(/\s+/).includes(name),
      add: (...names) => this.setAttribute('class', [...new Set([...(this.attrs.class || '').split(/\s+/), ...names])].filter(Boolean).join(' ')),
      remove: (...names) => this.setAttribute('class', (this.attrs.class || '').split(/\s+/).filter(name => !names.includes(name)).join(' ')),
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, ...viewport }; }
  fontSize() {
    const inline = parseFloat(this.style.fontSize || this.attrs['font-size']);
    if (inline) return inline;
    const classes = (this.attrs.class || '').split(/\s+/);
    const sizes = classes.filter(name => fontSizes[name]).map(name => fontSizes[name]);
    return sizes.at(-1) || this.parent?.fontSize() || 14;
  }
  getComputedTextLength() {
    let node = this, hiddenDetail = false, distant = false;
    while (node) {
      hiddenDetail ||= node.classList.contains('label-full');
      distant ||= node.classList.contains('fl-distant');
      node = node.parent;
    }
    if (hiddenDetail && distant) return 0;
    return [...this._text].reduce((sum, char) => sum + (glyphs[char] || 0.65),0) * this.fontSize() * 1.04
      + this.children.reduce((sum, child) => sum + child.getComputedTextLength() + Number(child.attrs.dx || 0),0);
  }
  matches(selector) {
    const attr = selector.match(/^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);
    if (attr) return attr[2] === undefined ? this.attrs[attr[1]] !== undefined : this.attrs[attr[1]] === attr[2];
    const parts = selector.split('.');
    return (!parts[0] || parts[0] === this.tagName) && parts.slice(1).every(name => this.classList.contains(name));
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim().split(/\s+/));
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (selectors.some(parts => {
          if (!child.matches(parts.at(-1))) return false;
          let parent = child.parent;
          for (let i = parts.length - 2; i >= 0; i--) {
            while (parent && !parent.matches(parts[i])) parent = parent.parent;
            if (!parent) return false;
            parent = parent.parent;
          }
          return true;
        })) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  cloneNode(deep) {
    const clone = new Element(this.tagName);
    clone.attrs = {...this.attrs};
    clone.style = {...this.style};
    clone._text = this._text;
    if (deep) clone.append(...this.children.map(child => child.cloneNode(true)));
    return clone;
  }
  serialize() {
    const attrs = {...this.attrs};
    const inline = Object.entries(this.style).map(([name,value]) => `${name.replace(/[A-Z]/g,letter => '-' + letter.toLowerCase())}:${value}`).join(';');
    if (inline) attrs.style = [attrs.style, inline].filter(Boolean).join(';');
    return `<${this.tagName}${Object.entries(attrs).map(([name,value]) => ` ${name}="${escape(value)}"`).join('')}>${escape(this._text)}${this.children.map(child => child.serialize()).join('')}</${this.tagName}>`;
  }
}

export function installSvgDOM() {
  globalThis.document = { baseURI: 'https://example.test/', createElementNS: (_, tag) => new Element(tag) };
  globalThis.XMLSerializer = class { serializeToString(element) { return element.serialize(); } };
}
