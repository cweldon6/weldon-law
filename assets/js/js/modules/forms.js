// js/modules/forms.js - Unified form system with resilient Power Automate integration

// ---------- Utilities ----------
const qs  = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const digitsOnly = str => (str || '').replace(/[^\d]/g, '');
const trimLeadingOne = digits => (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;

function resolveFlowUrl() {
  // Priority: window config → <meta name="flow-url"> → data attribute on module tag
  if (window.WELDON_CONFIG?.FLOW_URL) return window.WELDON_CONFIG.FLOW_URL;
  const meta = document.querySelector('meta[name="flow-url"]')?.content;
  if (meta) return meta;
  const mod = document.querySelector('script[type="module"][data-flow-url]');
  if (mod?.dataset.flowUrl) return mod.dataset.flowUrl;
  return '';
}
const FLOW_URL = resolveFlowUrl();

// ---------- Phone formatting ----------
function formatPhoneLive(element) {
  if (!element) return;
  element.addEventListener('input', () => {
    let digits = trimLeadingOne(digitsOnly(element.value));
    if (!digits) { element.value = ''; return; }
    if (digits.length <= 3) {
      element.value = `(${digits}`;
    } else if (digits.length <= 6) {
      element.value = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    } else {
      element.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
    }
  });
}

// ---------- Payload mapping (hyphenated keys) ----------
function shapePayloadForFlow(data) {
  return {
    siteKey:      data.siteKey || 'WL5616!SecureKey',
    'first-name': data['first-name'] || data.firstName || '',
    'last-name':  data['last-name']  || data.lastName  || '',
    email:        data.email || '',
    phone:        data.phone || '',
    interest:     data.interest || '',
    message:      data.message || '',
    company:      data.company || ''
  };
}

// ---------- Submit to Power Automate ----------
async function submitIntake(form, statusElement, errorElement) {
  // Honeypot: if filled, fake success
  const hp = form.querySelector('[name="company"]');
  if (hp && hp.value.trim()) {
    statusElement.textContent = 'Thanks—check your email for a confirmation.';
    statusElement.classList.remove('hidden');
    errorElement.classList.add('hidden');
    form.reset();
    return;
  }

  // Gather values
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());

  // Normalize phone
  const phoneField = form.querySelector('[name="phone"]');
  const phone = phoneField ? phoneField.value : '';
  data.phone = trimLeadingOne(digitsOnly(phone));

  // Validate requireds
  let isValid = true;
  form.querySelectorAll('[required]').forEach(field => {
    const filled = !!(field.value && field.value.trim());
    field.toggleAttribute('aria-invalid', !filled);
    if (!filled) isValid = false;
  });

  if (!isValid) {
    errorElement.textContent = 'Please fill in the required fields.';
    errorElement.classList.remove('hidden');
    statusElement.classList.add('hidden');
    return;
  }

  // UI
  errorElement.classList.add('hidden');
  statusElement.textContent = 'Sending…';
  statusElement.classList.remove('hidden');

  try {
    if (!FLOW_URL) throw new Error('Missing FLOW_URL');

    const payload = shapePayloadForFlow(data);

    const resp = await fetch(FLOW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // mode: 'cors'  // default is fine; success requires CORS headers on PA Response
    });

    const text = await resp.text();
    let json = null; try { json = JSON.parse(text); } catch {}

    // Treat any 2xx as success; prefer Flow's { success:true } if present
    if (resp.ok && (json?.success !== false)) {
      statusElement.textContent = 'Thanks—check your email for a confirmation.';
      form.reset();

      // Auto-close mobile sheet if this is the mobile form
      if (form.id === 'intakeFormStickyMobile') {
        setTimeout(() => {
          if (window.closeMobileSheet) window.closeMobileSheet();
        }, 500);
      }
      return;
    }

    const serverMsg = (json && (json.message || json.error)) || text || 'Server error';
    throw new Error(serverMsg);

  } catch (error) {
    console.error('Form submission error:', error);
    const looksCors = /cors|origin|preflight|forbidden|blocked/i.test(String(error));
    errorElement.textContent = looksCors
      ? 'Submission blocked by browser security (CORS). Please email chris@weldon.law or call (856) 890-2944.'
      : 'Sorry, something went wrong. Please email chris@weldon.law or call (856) 890-2944.';
    errorElement.classList.remove('hidden');
    statusElement.classList.add('hidden');
  }
}

// ---------- Initialize individual forms ----------
function initializeIntakeForm(formId, statusId, errorId, phoneId) {
  const form = qs('#' + formId);
  if (!form) return;

  // Phone formatting
  formatPhoneLive(qs('#' + phoneId));

  const statusElement = qs('#' + statusId);
  const errorElement = qs('#' + errorId);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitIntake(form, statusElement, errorElement);
  });
}

// Footer form (different structure)
function initializeFooterForm() {
  const form = qs('#intakeFormFooterDesktop');
  if (!form) return;

  formatPhoneLive(qs('#ft-phone'));

  const statusElement = qs('#ft-status');
  const errorElement = qs('#ft-error');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitIntake(form, statusElement, errorElement);
  });
}

// ---------- CTA Button Routing ----------
function initCTARouting() {
  const ctaButton = qs('#ctaGetHelp');
  if (!ctaButton) return;

  ctaButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.innerWidth <= 768) {
      qs('#openIntakeMobile')?.click();
    } else {
      window.location.href = 'contact.html';
    }
  });
}

// ---------- Mobile sheet management ----------
function initMobileSheet() {
  const sheet = qs('#intakeSheet');
  const openButton = qs('#openIntakeMobile');
  const closeButton = qs('#closeIntakeMobile');
  if (!sheet || !openButton || !closeButton) return;

  function trapFocus(container, enabled) {
    if (!container) return;

    const getFocusable = () => container.querySelectorAll(
      'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])'
    );

    function handleKeydown(e) {
      if (!enabled) return;

      if (e.key === 'Escape') { closeMobileSheet(); return; }
      if (e.key !== 'Tab') return;

      const focusable = Array.from(getFocusable()).filter(
        el => !el.disabled && el.offsetParent !== null
      );
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        last.focus(); e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus(); e.preventDefault();
      }
    }

    if (container.__trapHandler) {
      document.removeEventListener('keydown', container.__trapHandler);
    }
    container.__trapHandler = handleKeydown;
    document.addEventListener('keydown', handleKeydown);
  }

  function openMobileSheet() {
    sheet.setAttribute('aria-hidden', 'false');
    openButton.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { qs('#sm-first-name')?.focus(); }, 100);
    trapFocus(sheet, true);
  }

  function closeMobileSheet() {
    sheet.setAttribute('aria-hidden', 'true');
    openButton.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    trapFocus(sheet, false);
    openButton.focus();
  }

  openButton.addEventListener('click', (e) => { e.preventDefault(); openMobileSheet(); });
  closeButton.addEventListener('click', closeMobileSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeMobileSheet(); });

  window.closeMobileSheet = closeMobileSheet;
}

// ---------- Mobile bottom padding adjustment ----------
function adjustBottomPaddingMobile() {
  const mobileBar = qs('.intake-stick__mobilebar');
  if (!mobileBar) return;
  const height = mobileBar.getBoundingClientRect().height || 56;
  document.body.style.paddingBottom = window.innerWidth <= 768 ? `${height + 8}px` : '';
}

// ---------- Public init ----------
export function initForms() {
  console.log('Initializing form system');

  // Forms
  initializeIntakeForm('intakeFormStickyMobile', 'sm-status', 'sm-error', 'sm-phone');
  initializeFooterForm();

  // UI helpers
  initCTARouting();
  initMobileSheet();
  adjustBottomPaddingMobile();

  // Responsive listeners
  window.addEventListener('resize', adjustBottomPaddingMobile);
  window.addEventListener('orientationchange', adjustBottomPaddingMobile);

  console.log('Form system ready');
}
