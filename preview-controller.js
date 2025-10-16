/**
 * PreviewController - Manages the unified will preview with scroll synchronization
 * Handles rendering the complete will document and auto-scrolling to sections
 */
import { readIntake, deriveTokensFromIntake } from './intake-store.js';
import { TabPopulators } from './app.js';

// Preview anchor map (limited to testator for this iteration)
const SECTION_ANCHORS = {
  testator: '#section-testator',
  namebank: '#section-testator',
  family: '#section-family',
  debts: '#article-debts',
  gifts: '#article-gifts',
  residuary: '#article-residuary',
  executors: '#article-executors',
  powers: '#article-powers',
  misc: '#article-misc',
  trusts: '#article-trusts',
  signature: '#article-signature'
};

const SECTION_MARKERS = {
  debts: '— PAYMENT OF DEBTS, EXPENSES, AND TAXES',
  gifts: '— TANGIBLE PERSONAL PROPERTY',
  residuary: '— RESIDUARY ESTATE',
  executors: '— EXECUTORS',
  powers: '— FIDUCIARY POWERS',
  misc: '— MISCELLANEOUS PROVISIONS',
  trusts: '— TRUST PROVISIONS'
};

// Article order and structure - Matching old system structure
const ARTICLE_STRUCTURE = [
  { key: 'testator', anchor: 'section-testator', title: null, tab: 'Testator', isIntroduction: true },
  { key: 'family', anchor: 'section-family', title: 'Identification of Family', tab: 'Family', isIntroduction: true },
  { key: 'debts', anchor: 'article-debts', title: 'ARTICLE I — PAYMENT OF DEBTS, EXPENSES, AND TAXES', tab: 'Debts' },
  { key: 'gifts', anchor: 'article-gifts', title: 'ARTICLE II — TANGIBLE PERSONAL PROPERTY', tab: 'Gifts' },
  { key: 'residuary', anchor: 'article-residuary', title: 'ARTICLE III — RESIDUARY ESTATE', tab: 'Residuary' },
  { key: 'executors', anchor: 'article-executors', title: 'ARTICLE IV — EXECUTORS', tab: 'Executors' },
  { key: 'powers', anchor: 'article-powers', title: 'ARTICLE V — FIDUCIARY POWERS', tab: 'Powers' },
  { key: 'misc', anchor: 'article-misc', title: 'ARTICLE VI — MISCELLANEOUS PROVISIONS', tab: 'Miscellaneous' },
  { key: 'trusts', anchor: 'article-trusts', title: 'ARTICLE VII — TRUST PROVISIONS', tab: 'Trusts' },
  { key: 'signature', anchor: 'article-signature', title: 'ARTICLE VIII — EXECUTION', tab: 'Signature' }
];

class PreviewController {
  constructor() {
    this.container = null;
    this.scrollHost = null;
    this.updateTimeout = null;
    this.Bus = null; // Will be injected
    this.pendingScroll = null;
    this.forceImmediateRender = false;
  this.renderVersion = 0;
  this.nextRenderVersion = 0;
    
    // Import clause engine for rendering
    this.clauseEngine = null;
    this.initClauseEngine();
  }

  async initClauseEngine() {
    try {
      const module = await import('../shared/clause-engine.js');
      this.clauseEngine = module.default || module;
    } catch (error) {
      console.error('Failed to load clause engine:', error);
    }
  }

  /**
   * Mount the preview controller to a DOM container
   */
  mount(container, bus = null, getAppState = null) {
    if (typeof container === 'string') {
      this.container = document.getElementById(container);
    } else {
      this.container = container;
    }
    
    if (!this.container) {
      console.error('PreviewController: Container not found');
      return;
    }

    this.scrollHost = this._resolveScrollHost(this.container);

    // Store event bus reference and state accessor
    this.Bus = bus;
    this.getAppState = getAppState;

    // Set up event listeners if bus is available
    if (this.Bus) {
      this.setupEventListeners();
    }

    return this;
  }

  /**
   * Set up event bus listeners
   */
  setupEventListeners() {
    if (!this.Bus) return;

    this.Bus.on('preview-update', (payload = {}) => {
      // Get current state and render
      const intake = this.getAppState?.().intake || {};
      this.renderAll(intake, payload);
    });

    this.Bus.on('tab-change', (data = {}) => {
      this.scrollToSection(data.tab, data.displayName);
    });
  }

  /**
   * Render the complete will document
   */
  renderAll(state = {}, meta = {}) {
    if (!this.container) {
      console.warn('PreviewController not mounted');
      return;
    }

    const html = this.buildCompleteWill(state);
    
    // Clear timeout for any pending updates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    const shouldForceImmediate = Boolean(this.forceImmediateRender || meta?.forceImmediate);
    const delay = shouldForceImmediate ? 0 : 100;
    this.forceImmediateRender = false;
    const scheduledRenderVersion = ++this.nextRenderVersion;

    // Debounced update to prevent jank while typing
    this.updateTimeout = setTimeout(() => {
      const host = this.scrollHost || this.container;
      const currentScroll = host.scrollTop;
      this.container.innerHTML = html;
      host.scrollTop = currentScroll; // Preserve scroll position
      this.renderVersion = scheduledRenderVersion;
      requestAnimationFrame(() => this._applyPendingScroll());
    }, delay);
  }

  /**
   * Build the complete will HTML structure
   */
  buildCompleteWill(state) {
    const articles = ARTICLE_STRUCTURE.map(article => {
      return this.renderSection(article.key, state, article);
    });

    const fullName = this.getTokenValue(state, 'ClientFullName') || '[[ClientFullName]]';
    const headerName = fullName ? String(fullName).toUpperCase() : '[[ClientFullName]]';

    return `
      <div class="will-document">
        <div class="will-header">
          <h1>LAST WILL AND TESTAMENT OF ${headerName}</h1>
        </div>
        
        ${articles.join('\n\n')}
      </div>
    `;
  }

  /**
   * Render a specific section/article
   */
  renderSection(sectionKey, state, articleInfo) {
    if (!articleInfo) {
      articleInfo = ARTICLE_STRUCTURE.find(a => a.key === sectionKey);
      if (!articleInfo) {
        return `<div>Unknown section: ${sectionKey}</div>`;
      }
    }

    const content = this.getArticleContent(sectionKey, state);
    
    // Handle testator as unheaded introduction
    if (articleInfo.isIntroduction) {
      return `
        <section class="will-introduction" data-section="${sectionKey}">
          <span id="${articleInfo.anchor}" class="section-anchor"></span>
          <div class="introduction-content">
            ${content || `<p class="placeholder-content">[Testator introduction - Content will appear as you complete the ${articleInfo.tab} section]</p>`}
          </div>
        </section>
      `;
    }
    
    return `
      <section class="will-article" data-section="${sectionKey}">
        <span id="${articleInfo.anchor}" class="article-anchor"></span>
        <h2 class="article-title">${articleInfo.title}</h2>
        <div class="article-content">
          ${content || `<p class="placeholder-content">[${articleInfo.title} - Content will appear as you complete the ${articleInfo.tab} section]</p>`}
        </div>
      </section>
    `;
  }

  /**
   * Get content for a specific article based on current state
   */
  getArticleContent(sectionKey, state) {
    try {
      switch (sectionKey) {
        case 'testator':
          return TabPopulators._tesPopulate();
        case 'family':
          return TabPopulators._famPopulate();
        case 'debts':
          return TabPopulators._debPopulate();
        case 'gifts':
          return TabPopulators._gifPopulate();
        case 'residuary':
          return TabPopulators._resPopulate();
        case 'executors':
          return TabPopulators._exePopulate();
        case 'powers':
          return TabPopulators._powPopulate();
        case 'misc':
          return TabPopulators._miscPopulate();
        case 'trusts':
          return TabPopulators._truPopulate();
        case 'signature':
          return TabPopulators._sigPopulate();
        default:
          return null;
      }
    } catch (error) {
      console.error(`Error rendering ${sectionKey} article:`, error);
      return `<p class="error-content">Error rendering ${sectionKey} content</p>`;
    }
  }

  /**
   * Render testator identification article
   */
  renderTestatorArticle(state) {
    const name = this.getTokenValue(state, 'ClientFullName');
    const address = this.getTokenValue(state, 'ClientAddressInline');
    
    if (!name && !address) return null;

    return `
      <p>I, <strong>${name || '[NAME]'}</strong>, of ${address || '[ADDRESS]'}, being of sound mind and memory, do hereby make, publish, and declare this to be my Last Will and Testament, hereby revoking all prior Wills and Codicils made by me.</p>
    `;
  }

  /**
   * Render debts and taxes article
   */
  renderDebtsArticle(state) {
    // Use clause engine to get standard debts clause
    if (this.clauseEngine && this.clauseEngine.getClause) {
      const clause = this.clauseEngine.getClause('debts-standard');
      return clause ? this.hydrateTokens(clause.content, state) : null;
    }
    
    return `
      <p>I direct that all my just debts, funeral expenses, and expenses of administration be paid as soon as practicable after my death.</p>
    `;
  }

  /**
   * Render gifts article 
   */
  renderGiftsArticle(state) {
    // This will be populated based on gifts entered in the system
    const hasGifts = state.gifts && Object.keys(state.gifts).length > 0;
    
    if (!hasGifts) return null;

    // Render specific bequests from state
    const giftClauses = Object.entries(state.gifts || {}).map(([id, gift]) => {
      return `<p><strong>To ${gift.beneficiary}</strong>: ${gift.description}</p>`;
    });

    return giftClauses.join('\n');
  }

  /**
   * Render residuary estate article
   */
  renderResiduaryArticle(state) {
    if (this.clauseEngine && this.clauseEngine.getClause) {
      const clause = this.clauseEngine.getClause('residuary-standard');
      return clause ? this.hydrateTokens(clause.content, state) : null;
    }

    return null;
  }

  /**
   * Render executors article
   */
  renderExecutorsArticle(state) {
    const primaryExecutor = this.getTokenValue(state, 'PrimaryExecutorName');
    
    if (!primaryExecutor) return null;

    return `
      <p>I hereby nominate and appoint <strong>${primaryExecutor}</strong> as the Executor of this Will. If ${primaryExecutor} is unable or unwilling to serve, I nominate the successor Executor as set forth herein.</p>
    `;
  }

  /**
   * Render powers article
   */
  renderPowersArticle(state) {
    if (this.clauseEngine && this.clauseEngine.getClause) {
      const clause = this.clauseEngine.getClause('powers-standard');
      return clause ? this.hydrateTokens(clause.content, state) : null;
    }

    return null;
  }

  /**
   * Render trusts article
   */
  renderTrustsArticle(state) {
    // Only show if trusts are configured
    const hasTrusts = state.trusts && Object.keys(state.trusts).length > 0;
    if (!hasTrusts) return null;

    return `<p>Trust provisions will be detailed based on configuration.</p>`;
  }

  /**
   * Render signature article
   */
  renderSignatureArticle(state) {
    const testatorName = this.getTokenValue(state, 'ClientFullName');
    
    return `
      <p>IN WITNESS WHEREOF, I have hereunto set my hand this _____ day of _________, 2024.</p>
      
      <div class="signature-block">
        <div class="signature-line">
          <span class="signature-placeholder">_________________________________</span>
          <br>
          <span class="signature-name">${testatorName || '[TESTATOR NAME]'}</span>
        </div>
      </div>

      <div class="witness-section">
        <p>The foregoing instrument was signed by the Testator and declared by ${testatorName ? 'them' : '[him/her]'} to be ${testatorName ? 'their' : '[his/her]'} Last Will and Testament in our presence, and we, at ${testatorName ? 'their' : '[his/her]'} request and in ${testatorName ? 'their' : '[his/her]'} presence and in the presence of each other, have subscribed our names as witnesses.</p>
        
        <div class="witness-block">
          <div class="witness-line">
            <span>_________________________________</span><br>
            <span>Witness #1</span>
          </div>
          <div class="witness-line">
            <span>_________________________________</span><br>
            <span>Witness #2</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Get token value from state (with fallback)
   */
  getTokenValue(state, tokenName) {
    // Use proper token derivation function
    try {
      const derived = deriveTokensFromIntake(state);
      if (derived[tokenName]) return derived[tokenName];
    } catch (error) {
      console.warn('Token derivation failed:', error);
    }
    
    // Try direct state access as fallback
    if (state[tokenName]) return state[tokenName];
    
    // Try nested client object
    if (state.client && state.client[tokenName]) return state.client[tokenName];

    return null;
  }

  /**
   * Hydrate tokens in clause content
   */
  hydrateTokens(content, state) {
    if (!content) return content;

    // Replace token placeholders with actual values
    return content.replace(/\[([^\]]+)\]/g, (match, tokenName) => {
      const value = this.getTokenValue(state, tokenName);
      return value || match; // Keep placeholder if no value found
    });
  }

  /**
   * Update a specific section without full re-render
   */
  updateSection(sectionKey, state) {
    if (!this.container) return;

    const sectionElement = this.container.querySelector(`[data-section="${sectionKey}"]`);
    if (sectionElement) {
      const articleInfo = ARTICLE_STRUCTURE.find(a => a.key === sectionKey);
      const newContent = this.renderSection(sectionKey, state, articleInfo);
      
      // Create temporary element to parse new content
      const temp = document.createElement('div');
      temp.innerHTML = newContent;
      const newSection = temp.firstElementChild;
      
      // Replace existing section
      sectionElement.parentNode.replaceChild(newSection, sectionElement);
    }
  }

  /**
   * Get section anchor mapping (for external use)
   */
  static getSectionAnchors() {
    return { ...SECTION_ANCHORS };
  }

  /**
   * Get article structure (for external use)  
   */
  static getArticleStructure() {
    return [...ARTICLE_STRUCTURE];
  }

  scrollToSection(tabKey, displayName = '') {
    if (!this.container || !tabKey) return;

    const targetVersion = this.nextRenderVersion || this.renderVersion;
    this.pendingScroll = { tabKey, displayName, tries: 0, targetVersion };
    this.forceImmediateRender = targetVersion > this.renderVersion;
    if (this.renderVersion >= targetVersion) {
      requestAnimationFrame(() => this._applyPendingScroll());
    }
  }

  _smoothScrollToAnchor(anchorEl) {
    const host = this.scrollHost || this.container;
    if (!host) return;

    const hostRect = host.getBoundingClientRect();
    const targetRect = anchorEl.getBoundingClientRect();
    const top = host.scrollTop + (targetRect.top - hostRect.top);
    host.scrollTo({ top: Math.max(top, 0), behavior: 'auto' });
  }

  _smoothScrollIntoView(el) {
    const host = this.scrollHost || this.container;
    if (!host) return;

    const hostRect = host.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const top = host.scrollTop + (elRect.top - hostRect.top);
    host.scrollTo({ top: Math.max(top, 0), behavior: 'auto' });
  }

  _focusNearestHeading(fromEl) {
    if (!fromEl) return;

    const articleHeading = fromEl.closest('.will-article')?.querySelector('.article-title');
    const introContent = fromEl.closest('.will-introduction')?.querySelector('.introduction-content');
    const focusTarget = articleHeading || introContent;
    if (!focusTarget || typeof focusTarget.focus !== 'function') return;

    const previousTabIndex = focusTarget.getAttribute('tabindex');
    focusTarget.setAttribute('tabindex', '-1');
    focusTarget.focus({ preventScroll: true });
    if (previousTabIndex === null) {
      focusTarget.removeAttribute('tabindex');
    } else {
      focusTarget.setAttribute('tabindex', previousTabIndex);
    }
  }

  _resolveScrollHost(container) {
    if (!container) return null;
    // The container itself (preview-content) is the scrollable element in the new 3-rail layout
    // No need to look for a parent scroll host
    return container;
  }

  _scrollPreviewToTop() {
    const host = this.scrollHost || this.container;
    if (!host) return;

    host.scrollTop = 0;
    this.container.scrollTop = 0;
    host.scrollTo({ top: 0, behavior: 'auto' });
    requestAnimationFrame(() => {
      host.scrollTo({ top: 0, behavior: 'auto' });
      this.container.scrollTop = 0;
    });
  }

  _scrollToTextMarker(markerText) {
    if (!this.container || !markerText) return false;

    const host = this.scrollHost || this.container;
    if (!host) return false;

    const normalizedMarker = markerText.toUpperCase();
    const selectors = [
      '.article-title',
      '.article-content h1',
      '.article-content h2',
      '.article-content h3',
      '.article-content p'
    ];

    for (const selector of selectors) {
      const elements = this.container.querySelectorAll(selector);
      for (const element of elements) {
        const text = (element.textContent || '').toUpperCase();
        if (!text) continue;
        if (text.includes(normalizedMarker)) {
          this._smoothScrollIntoView(element);
          this._focusNearestHeading(element);
          return true;
        }
      }
    }
    return false;
  }

  _scrollToAnchorFallback(selector) {
    if (!selector) return false;
    const anchor = this.container.querySelector(selector);
    if (!anchor) return false;
    this._smoothScrollToAnchor(anchor);
    this._focusNearestHeading(anchor);
    return true;
  }

  _scrollSignatureToBottom() {
    if (!this.container) return false;
    const article = this.container.querySelector('[data-section="signature"]');
    if (article) {
      this._scrollElementToBottom(article);
      this._focusNearestHeading(article);
      return true;
    }
    this._scrollPreviewToBottom();
    return true;
  }

  _scrollElementToBottom(element) {
    const host = this.scrollHost || this.container;
    if (!host || !element) return;

    const hostRect = host.getBoundingClientRect();
    const elRect = element.getBoundingClientRect();
    const targetBottom = host.scrollTop + (elRect.bottom - hostRect.top);
    const top = targetBottom - host.clientHeight;
    host.scrollTo({ top: Math.max(top, 0), behavior: 'auto' });
  }

  _scrollPreviewToBottom() {
    const host = this.scrollHost || this.container;
    if (!host) return;

    const target = host.scrollHeight - host.clientHeight;
    host.scrollTo({ top: Math.max(target, 0), behavior: 'auto' });
  }

  _applyPendingScroll() {
    if (!this.pendingScroll) return;

    const { tabKey, tries = 0, targetVersion } = this.pendingScroll;

    if (targetVersion && this.renderVersion < targetVersion) {
      if (tries >= 20) {
        this.pendingScroll = null;
        return;
      }
      this.pendingScroll.tries = tries + 1;
      setTimeout(() => this._applyPendingScroll(), 40);
      return;
    }

    if (tries >= 20) {
      this.pendingScroll = null;
      return;
    }

    const didScroll = this._executeScrollForTab(tabKey);
    if (didScroll) {
      this.pendingScroll = null;
      return;
    }

    this.pendingScroll.tries = tries + 1;
    setTimeout(() => this._applyPendingScroll(), 60);
  }

  _executeScrollForTab(tabKey) {
    if (!tabKey) return false;

    if (['testator', 'namebank', 'family'].includes(tabKey)) {
      this._scrollPreviewToTop();
      return true;
    }

    if (tabKey === 'signature') {
      return this._scrollSignatureToBottom();
    }

    if (SECTION_MARKERS[tabKey]) {
      const markerText = SECTION_MARKERS[tabKey];
      if (this._scrollToTextMarker(markerText)) {
        return true;
      }
      return this._scrollToAnchorFallback(SECTION_ANCHORS[tabKey]);
    }

    if (SECTION_ANCHORS[tabKey]) {
      return this._scrollToAnchorFallback(SECTION_ANCHORS[tabKey]);
    }

    return false;
  }
}

// Export for ES6 modules
export default PreviewController;

// Also attach to window for global access if needed
if (typeof window !== 'undefined') {
  window.PreviewController = PreviewController;
}