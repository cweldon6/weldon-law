/* Weldon Law – site.js
   One small file to handle:
   - Mobile nav toggle
   - “Areas of Practice” dropdown (click + keyboard)
   - Phone auto-formatting
   - Inline form validation (shared across pages)
   - Safe(-r) form submit via proxy (honeypot + timestamp)
*/

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // --- 1) Mobile nav toggle ---
  function setupNavToggle() {
    const toggle = $('#menuToggle');
    const nav = $('.site-nav');
    if (!toggle || !nav) return;

    toggle.addEventListener('click', () => {
      const open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', String(!open));
      toggle.setAttribute('aria-expanded', String(!open));
      document.body.classList.toggle('nav-open', !open);
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!nav.contains(e.target) && e.target !== toggle && nav.getAttribute('data-open') === 'true') {
        nav.setAttribute('data-open', 'false');
        toggle.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('nav-open');
      }
    });
  }

  // --- 2) "Areas of Practice" dropdown (click + keyboard) ---
  function setupPracticeDropdown() {
    const trigger = $('#practiceTrigger');
    const menu = $('#practiceMenu');
    if (!trigger || !menu) return;

    const open = (v) => {
      menu.style.display = v ? 'block' : 'none';
      trigger.setAttribute('aria-expanded', v ? 'true' : 'false');
      if (v) {
        // focus first item for keyboard users
        const firstLink = menu.querySelector('a,button,[tabindex]:not([tabindex="-1"])');
        if (firstLink) firstLink.focus({ preventScroll: true });
      }
    };

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      const isOpen = menu.style.display === 'block';
      open(!isOpen);
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') open(false);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        open(true);
      }
    });

    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) open(false);
    });

    // Close on Escape from within menu
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        open(false);
        trigger.focus();
      }
    });
  }

  // --- 3) Phone auto-format (US) ---
  function digitsOnly(str) {
    return (str || '').replace(/\D+/g, '');
  }

  function formatUSPhone(d) {
    // (xxx) xxx-xxxx or graceful partial formatting
    const x = digitsOnly(d).slice(0, 10);
    const len = x.length;
    if (len === 0) return '';
    if (len < 4) return `(${x}`;
    if (len < 7) return `(${x.slice(0, 3)}) ${x.slice(3)}`;
    return `(${x.slice(0, 3)}) ${x.slice(3, 6)}-${x.slice(6)}`;
  }

  function setupPhoneFormatting() {
    $$('input[data-phone]').forEach((input) => {
      const rawMirror = input.form ? input.form.querySelector('input[name="phone_raw"]') : null;

      input.addEventListener('input', () => {
        const pos = input.selectionStart;
        const before = input.value;
        input.value = formatUSPhone(before);
        if (rawMirror) rawMirror.value = digitsOnly(input.value);
        // best-effort caret preservation
        try { input.setSelectionRange(pos, pos); } catch (e) {}
      });

      input.addEventListener('blur', () => {
        input.value = formatUSPhone(input.value);
        if (rawMirror) rawMirror.value = digitsOnly(input.value);
      });
    });
  }

  // --- 4) Inline form validation (shared) ---
  const REQUIRED_FIELDS = [
    { name: 'first-name', label: 'First name' },
    { name: 'last-name', label: 'Last name' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone', type: 'phone' },
    { name: 'interest', label: 'Area of interest' },
    { name: 'message', label: 'Message' },
  ];

  function ensureErrorContainer(field) {
    // Use a sibling .field-error if present; otherwise create one
    let container = field.parentElement && field.parentElement.querySelector('.field-error');
    if (!container && field.parentElement) {
      container = document.createElement('div');
      container.className = 'field-error';
      field.parentElement.appendChild(container);
    }
    return container;
  }

  function emailValid(v) {
    // simple but effective pattern
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
  }

  function phoneValid(v) {
    return digitsOnly(v).length === 10;
  }

  function validateForm(form) {
    let ok = true;
    const summary = form.querySelector('[data-error-summary]');
    if (summary) summary.innerHTML = '';

    REQUIRED_FIELDS.forEach(({ name, label, type }) => {
      const field = form.querySelector(`[name="${name}"]`);
      if (!field) return;
      const value = (field.value || '').trim();
      const container = ensureErrorContainer(field);
      let err = '';

      if (!value) {
        err = `${label} is required.`;
      } else if (type === 'email' && !emailValid(value)) {
        err = 'Please enter a valid email.';
      } else if (type === 'phone' && !phoneValid(value)) {
        err = 'Please enter a 10-digit phone number.';
      }

      if (container) container.textContent = err;
      if (err) ok = false;
      field.setAttribute('aria-invalid', err ? 'true' : 'false');
    });

    if (!ok && summary) {
      // Build a brief summary with links to fields
      const problems = [];
      REQUIRED_FIELDS.forEach(({ name, label, type }) => {
        const field = form.querySelector(`[name="${name}"]`);
        if (!field) return;
        const hasErr = field.getAttribute('aria-invalid') === 'true';
        if (hasErr) {
          const id = field.id || name;
          if (!field.id) field.id = id;
          problems.push(`<li><a href="#${id}">${label}</a></li>`);
        }
      });
      if (problems.length) {
        summary.innerHTML =
          `<p>Please fix the following:</p><ul>${problems.join('')}</ul>`;
        summary.focus();
      }
    }

    return ok;
  }

  // --- 5) Safe(-r) fetch submit via proxy ---
  async function submitFormViaProxy(form) {
    const endpoint = form.getAttribute('data-endpoint') || window.INTAKE_PROXY || ''; // e.g., /api/intake
    if (!endpoint) throw new Error('No submit endpoint configured');

    const data = Object.fromEntries(new FormData(form).entries());

    // Honeypot: if filled, silently succeed (or you can hard fail)
    if ((data.website || '').trim() !== '') {
      return { ok: true, spam: true };
    }

    // Add timestamp (ms since epoch)
    data.ts = Date.now();

    // Optional shared secret – set window.INTAKE_SECRET at build or inject here
    if (window.INTAKE_SECRET) data.secret = window.INTAKE_SECRET;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json().catch(() => ({}));
  }

  function setupIntakeForms() {
    $$('form[data-validate="intake"]').forEach((form) => {
      const summary = form.querySelector('[data-error-summary]');
      if (summary) {
        summary.setAttribute('tabindex', '-1'); // focusable for SR users
        summary.setAttribute('role', 'alert');
        summary.setAttribute('aria-live', 'assertive');
      }

      // Prepare phone_raw mirror if missing
      const phone = form.querySelector('input[name="phone"]');
      if (phone && !form.querySelector('input[name="phone_raw"]')) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'phone_raw';
        form.appendChild(hidden);
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Clear any prior notices
        const success = form.querySelector('[data-success]');
        if (success) success.textContent = '';
        if (summary) summary.innerHTML = '';

        // Validate
        if (!validateForm(form)) return;

        // Disable button while submitting
        const btn = form.querySelector('[type="submit"]');
        const orig = btn ? btn.textContent : null;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Submitting…';
        }

        try {
          const result = await submitFormViaProxy(form);
          // Show success UI
          if (success) {
            success.textContent = 'Thanks — your inquiry was sent. We’ll be in touch soon.';
          }
          // Optionally reset the form (except for select defaults)
          form.reset();
          // Keep focus visible
          if (success) success.focus();
        } catch (err) {
          if (summary) {
            summary.innerHTML = `<p>Sorry, we couldn’t submit the form. Please try again in a moment.</p>`;
            summary.focus();
          }
        } finally {
          if (btn && orig) {
            btn.disabled = false;
            btn.textContent = orig;
          }
        }
      });
    });
  }

  // --- 6) Mobile sheet open/close (Home) ---
  function setupMobileSheet() {
    const sheet = $('[data-js="mobile-sheet"]');
    if (!sheet) return;

    const openBtn = $('[data-js="open-sheet"]');
    const closeBtn = $('[data-js="close-sheet"]');
    const scrim = $('[data-js="sheet-scrim"]');

    const setOpen = (v) => {
      sheet.classList.toggle('open', v);
      sheet.setAttribute('aria-hidden', v ? 'false' : 'true');
      document.body.classList.toggle('no-scroll', v);
      if (v) {
        const first = sheet.querySelector('input,select,textarea,button,[href],[tabindex]:not([tabindex="-1"])');
        if (first) first.focus({ preventScroll: true });
      } else if (openBtn) {
        openBtn.focus({ preventScroll: true });
      }
    };

    if (openBtn) openBtn.addEventListener('click', () => setOpen(true));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
    if (scrim) scrim.addEventListener('click', () => setOpen(false));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheet.classList.contains('open')) setOpen(false);
    });
  }

  // --- Boot ---
  document.addEventListener('DOMContentLoaded', () => {
    setupNavToggle();
    setupPracticeDropdown();
    setupPhoneFormatting();
    setupIntakeForms();
    setupMobileSheet();
  });
})();
