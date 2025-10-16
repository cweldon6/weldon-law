// /drafting/app.js - Dynamic form rendering for unified intake system
import { TABS, FORM } from "../shared/intake-schema.js";
import { STATES, NJ_COUNTIES, MONTHS, optionsHtml, NAME_BANK_BASE_ROLES, NAME_BANK_ROLE_BADGES, CHARITY_PURPOSES } from "../shared/lookups.js";
import { readIntake, writeIntake, onInputBind, deriveTokensFromIntake, listPeopleByRole, fullName } from "./intake-store.js";
import { loadManifest, getClauses, hydrateBody } from "../shared/clause-engine.js";
import PreviewController from "./preview-controller.js";

const SUFFIX_OPTIONS = ["", "Jr.", "Sr.", "II", "III", "IV", "V", "Esq.", "MD", "PhD"];
const CHILD_RELATIONSHIP_TYPES = ["Biological", "Adopted", "Step-child", "Conceived with ART"];
const CLIENT_PARENT_ID = "__CLIENT__";
const DEFAULT_FAMILY_CLAUSE_ID = "family.statement.default_placeholder";

function buildYearOptions(selected) {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear; y >= currentYear - 120; y -= 1) {
    years.push(String(y));
  }
  let options = `<option value="">Year</option>`;
  options += years.map(year => `<option value="${year}" ${year === String(selected || "") ? "selected" : ""}>${year}</option>`).join("");
  return options;
}

// Build a canonical intake object: include ALL schema-defined fields with empty/null defaults
export function buildCanonicalIntake() {
  const all = {};
  const setEmptyForField = (field) => {
    if (!field || !field.id) return;
    const type = field.as;
    let empty;
    switch (type) {
      case 'checkbox': empty = false; break;
      case 'number': empty = null; break;
      default: empty = ''; break; // text, select, date, seg, static, button, etc.
    }
    all[field.id] = empty;
  };
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.fields && Array.isArray(node.fields)) node.fields.forEach(setEmptyForField);
    if (node.type === 'row' && node.fields) return; // handled above
    if (node.id) setEmptyForField(node);
  };
  for (const tabKey of Object.keys(FORM)) {
    const items = FORM[tabKey] || [];
    items.forEach(visit);
  }
  return all;
}

// Return a map of fieldId -> fieldType (from FORM schema)
export function getFieldTypeMap() {
  const typeMap = {};
  const collect = (field) => {
    if (!field || !field.id) return;
    typeMap[field.id] = field.as || 'text';
  };
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.fields && Array.isArray(node.fields)) node.fields.forEach(collect);
    if (node.type === 'row' && node.fields) return;
    if (node.id) collect(node);
  };
  for (const tabKey of Object.keys(FORM)) {
    const items = FORM[tabKey] || [];
    items.forEach(visit);
  }
  return typeMap;
}

function buildMonthOptions(selected) {
  return MONTHS.map((month, idx) => {
    const label = idx === 0 ? "Month" : month;
    const value = month;
    const selectedAttr = value === selected ? " selected" : "";
    return `<option value="${value}"${selectedAttr}>${label}</option>`;
  }).join("");
}

function getDaysInMonth(monthName, year) {
  const monthIndex = MONTHS.indexOf(monthName);
  if (monthIndex <= 0) return 31;
  const yearNum = parseInt(year, 10) || new Date().getFullYear();
  return new Date(yearNum, monthIndex, 0).getDate();
}

const PRIMARY_NAME_ROLES = NAME_BANK_BASE_ROLES;
const SPECIAL_ROLE_BADGES = NAME_BANK_ROLE_BADGES;

function getPrimaryRole(person = {}) {
  const all = Array.isArray(person.roles) ? person.roles.filter(Boolean) : [];
  if (person.primaryRole && PRIMARY_NAME_ROLES.includes(person.primaryRole)) {
    return person.primaryRole;
  }
  const match = all.find(role => PRIMARY_NAME_ROLES.includes(role));
  return match || "Other";
}

function normalizeNameBankPerson(person = {}) {
  const next = { ...person };
  const badges = Array.isArray(next.roles) ? next.roles.filter(Boolean) : [];
  const primary = getPrimaryRole({ ...next, roles: badges });
  next.primaryRole = PRIMARY_NAME_ROLES.includes(primary) ? primary : "Other";
  const filteredBadges = badges.filter(role => !PRIMARY_NAME_ROLES.includes(role));
  next.roles = [next.primaryRole, ...filteredBadges.filter(Boolean)];
  if (next.primaryRole === "Child") {
    if (!next.childRelationship || !CHILD_RELATIONSHIP_TYPES.includes(next.childRelationship)) {
      next.childRelationship = "Biological";
    }
    const isStepChild = next.childRelationship === "Step-child";
    if (next.childRelationship === "Biological") {
      next.childTreatAsBio = "Yes";
    } else if (!next.childTreatAsBio) {
      next.childTreatAsBio = "Yes";
    }

    // Migrate legacy single-parent field into the new structure if needed
    if (next.childOtherParentId && !next.childParentBId) {
      next.childParentBId = next.childOtherParentId;
    }

    if (next.childParentAId === undefined || next.childParentAId === null) {
      next.childParentAId = isStepChild ? "" : CLIENT_PARENT_ID;
    }
    if (next.childParentBId === undefined || next.childParentBId === null) {
      next.childParentBId = "";
    }

    if (isStepChild && next.childParentAId === CLIENT_PARENT_ID) {
      next.childParentAId = "";
    }
    if (!isStepChild && !next.childParentAId) {
      next.childParentAId = CLIENT_PARENT_ID;
    }

    delete next.childOtherParentId;
  } else {
    delete next.childRelationship;
    delete next.childTreatAsBio;
    delete next.childParentAId;
    delete next.childParentBId;
    delete next.childOtherParentId;
  }
  return next;
}

function buildFamilyContext(intake = {}) {
  const relationship = (intake.RelationshipStatus || "").toLowerCase();
  const spouseList = listPeopleByRole(intake, "Spouse");
  const partnerList = listPeopleByRole(intake, "Partner");
  const formerSpouseList = listPeopleByRole(intake, "Former Spouse");
  const guardianList = listPeopleByRole(intake, "Guardian");
  const childList = listPeopleByRole(intake, "Child");

  const hasChildrenFlag = String(intake.HasChildren || "").toLowerCase() === "yes";
  const childrenCountForm = parseInt(intake.ChildrenCount, 10);

  const getRel = person => (person?.childRelationship || "").toLowerCase();
  const stepChildren = childList.filter(child => getRel(child) === "step-child");
  const adoptedChildren = childList.filter(child => getRel(child) === "adopted");
  const artChildren = childList.filter(child => getRel(child) === "conceived with art");
  const clientChildren = childList.filter(child => getRel(child) !== "step-child");

  const spouseId = spouseList[0]?.id || "";
  const priorChildren = clientChildren.filter(child => {
    const parentA = child.childParentAId;
    const parentB = child.childParentBId;
    const hasClientParent = parentA === CLIENT_PARENT_ID || parentB === CLIENT_PARENT_ID;
    if (!hasClientParent) return false;
    const otherParentId = parentA === CLIENT_PARENT_ID ? parentB : parentA;
    if (!otherParentId || otherParentId === CLIENT_PARENT_ID) return false;
    return otherParentId !== spouseId;
  });

  const currentSpouseChildren = clientChildren.filter(child => {
    if (!spouseId) return false;
    const parentA = child.childParentAId;
    const parentB = child.childParentBId;
    const hasClientParent = parentA === CLIENT_PARENT_ID || parentB === CLIENT_PARENT_ID;
    if (!hasClientParent) return false;
    const otherParentId = parentA === CLIENT_PARENT_ID ? parentB : parentA;
    return otherParentId === spouseId;
  });

  const derivedClientChildrenCount = clientChildren.length > 0
    ? clientChildren.length
    : (hasChildrenFlag ? Math.max(childrenCountForm || 0, 1) : 0);
  const hasClientChildren = clientChildren.length > 0 || hasChildrenFlag;

  return {
    relationship,
    hasSpouse: spouseList.length > 0 || relationship === "married",
    hasPartner: partnerList.length > 0,
    hasFormerSpouse: formerSpouseList.length > 0,
    hasGuardian: guardianList.length > 0,
    hasClientChildren,
    hasStepChildren: stepChildren.length > 0,
    hasAdoptedChildren: adoptedChildren.length > 0,
    hasArtChildren: artChildren.length > 0,
    hasPriorChildren: priorChildren.length > 0,
    hasCurrentSpouseChildren: currentSpouseChildren.length > 0,
    clientChildrenCount: derivedClientChildrenCount,
    currentSpouseChildrenCount: currentSpouseChildren.length,
    artChildrenCount: artChildren.length
  };
}

function suggestFamilyClauses(intake = {}) {
  const ctx = buildFamilyContext(intake);
  const suggestions = new Set();

  switch (ctx.relationship) {
    case "widowed":
      if (ctx.hasClientChildren) {
        suggestions.add("family.statement.widowed_children");
      } else {
        suggestions.add("family.statement.widowed_no_children");
      }
      break;
    case "divorced":
      if (ctx.hasClientChildren) {
        if (ctx.hasFormerSpouse) {
          suggestions.add("family.statement.divorced_children_named");
        } else {
          suggestions.add("family.statement.divorced_children_general");
        }
      } else {
        suggestions.add("family.statement.divorced_no_children");
      }
      break;
    case "married":
      if (!ctx.hasClientChildren && ctx.hasStepChildren) {
        suggestions.add("family.statement.married_stepchildren_only");
        suggestions.add("family.statement.remarried_with_stepchildren");
      } else if (!ctx.hasClientChildren) {
        suggestions.add("family.statement.married_no_children");
      } else if (ctx.hasPriorChildren && ctx.hasCurrentSpouseChildren) {
        if (ctx.hasFormerSpouse) {
          suggestions.add("family.statement.remarried_both");
        } else {
          suggestions.add("family.statement.remarried_both_general");
        }
      } else if (ctx.hasPriorChildren) {
        if (ctx.hasFormerSpouse) {
          suggestions.add("family.statement.remarried_prior_children");
        } else {
          suggestions.add("family.statement.remarried_prior_children_general");
        }
      } else if (ctx.artChildrenCount > 0 && ctx.artChildrenCount === ctx.clientChildrenCount) {
        suggestions.add("family.statement.married_art_children");
      } else if (ctx.hasClientChildren) {
        suggestions.add("family.statement.married_children");
      }
      break;
    default:
      if (ctx.hasClientChildren) {
        suggestions.add("family.statement.unmarried_children");
      } else if (!ctx.hasStepChildren) {
        suggestions.add("family.statement.unmarried_no_children");
      }
      if (ctx.hasAdoptedChildren && !ctx.hasSpouse && !ctx.hasPartner) {
        suggestions.add("family.statement.single_with_adopted_children");
      }
      if (ctx.hasPartner && ctx.hasClientChildren) {
        suggestions.add("family.statement.unmarried_with_partner_children");
      }
      break;
  }

  if (ctx.relationship === "married" && ctx.hasStepChildren) {
    suggestions.add("family.statement.remarried_with_stepchildren");
  }
  if (ctx.hasPartner && ctx.relationship !== "married") {
    suggestions.add("family.statement.partner_cohabitation_disclaimer");
    suggestions.add("family.statement.de_facto_relationship");
  }
  if (ctx.hasFormerSpouse) {
    suggestions.add("family.statement.former_spouse_disclaimer");
  }
  if (ctx.hasPriorChildren) {
    suggestions.add("family.statement.children_from_prior_relationships");
  }
  if (ctx.relationship !== "married" && ctx.hasClientChildren && ctx.hasGuardian) {
    suggestions.add("family.statement.unmarried_with_named_guardian");
  }

  if (ctx.relationship === "married" && ctx.hasPriorChildren && ctx.hasAdoptedChildren) {
    suggestions.add("family.statement.remarried_prior_children_adopted");
  }

  if (suggestions.size === 0) {
    suggestions.add(DEFAULT_FAMILY_CLAUSE_ID);
  }

  return Array.from(suggestions);
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function isSelectionAutoManaged(selection = [], priorAuto = []) {
  if (!selection || selection.length === 0) return true;
  if (selection.length === 1 && selection[0] === DEFAULT_FAMILY_CLAUSE_ID) return true;
  return arraysEqual(selection, priorAuto);
}

function syncClauseSelectionUI(articleKey, selectedValues = []) {
  const selects = document.querySelectorAll(`.clause-select[data-article="${articleKey}"]`);
  if (!selects.length) return;
  const valueSet = new Set(selectedValues);
  selects.forEach(select => {
    Array.from(select.options).forEach(option => {
      option.selected = valueSet.has(option.value);
    });
  });
}

function resolveClauseId(articleKey, clauseId) {
  if (!clauseId) return clauseId;
  return articleKey === 'debts' ? Clauses.resolveDebtsClauseId(clauseId) : clauseId;
}

function normalizeArticleSelections(articleKey) {
  const existingSelections = App.state.selectedClauses || {};
  const hasStoredSelections = Object.prototype.hasOwnProperty.call(existingSelections, articleKey);
  const rawValue = existingSelections[articleKey];
  const needsCoercion = hasStoredSelections && !Array.isArray(rawValue);
  const rawSelections = Array.isArray(rawValue)
    ? rawValue
    : (rawValue ? [rawValue] : []);
  let normalized = rawSelections
    .map(id => resolveClauseId(articleKey, id))
    .filter(Boolean);

  if (articleKey === 'debts') {
    const config = Clauses.getDebtsConfig();
    const primaryIds = new Set(config.primary.map(clause => clause.id));
    const addonIdsSet = new Set(config.extras.map(clause => clause.id));
    const selectedPrimaryIds = normalized.filter(id => primaryIds.has(id));
    const preferredPrimaryId = selectedPrimaryIds[0]
      || config.primary.find(clause => clause.default)?.id
      || config.defaultPrimaryId
      || (config.primary[0]?.id ?? null);

    const addonIds = normalized.filter(id => addonIdsSet.has(id));
    const ordered = preferredPrimaryId ? [preferredPrimaryId, ...addonIds] : addonIds;
    const seen = new Set();
    normalized = ordered.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  } else {
    const seen = new Set();
    normalized = normalized.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  if (articleKey === 'powers' || articleKey === 'misc') {
    const config = articleKey === 'powers' ? Clauses.getPowersConfig() : Clauses.getMiscConfig();
    const allowedIds = new Set((config.extras || []).map(clause => clause.id));
    normalized = normalized.filter(id => allowedIds.has(id));
  }

  if (articleKey === 'trusts') {
    const config = Clauses.getTrustsConfig();
    const primaryIds = new Set((config.primary || []).map(clause => clause.id));
    const addonIdsSet = new Set((config.extras || []).map(clause => clause.id));
    const selectedPrimary = normalized.find(id => primaryIds.has(id));
    const preferredPrimaryId = selectedPrimary
      || (config.primary || []).find(clause => clause.default)?.id
      || config.defaultPrimaryId
      || (config.primary?.[0]?.id ?? null);

    const addonIds = normalized.filter(id => addonIdsSet.has(id));
    const ordered = preferredPrimaryId ? [preferredPrimaryId, ...addonIds] : addonIds;
    const allowedIds = new Set([...primaryIds, ...addonIdsSet]);
    const seen = new Set();
    normalized = ordered.filter(id => {
      if (!allowedIds.has(id)) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  if (hasStoredSelections && (needsCoercion || !arraysEqual(rawSelections, normalized))) {
    App.setState({
      selectedClauses: {
        ...existingSelections,
        [articleKey]: normalized
      }
    });
    return normalized;
  }

  return normalized;
}

function ensureDefaultPrimarySelection(articleKey, clauseId) {
  if (!clauseId) return;
  const existingSelections = App.state.selectedClauses || {};
  const currentRawList = existingSelections[articleKey] || [];
  const normalizedCurrent = currentRawList
    .map(id => resolveClauseId(articleKey, id))
    .filter(Boolean);

  if (normalizedCurrent.includes(clauseId)) {
    return;
  }

  const addonSelections = Array.from(new Set(normalizedCurrent.filter(id => isAddonClause(articleKey, id))));
  const nextSelections = [clauseId, ...addonSelections];

  App.setState({
    selectedClauses: {
      ...existingSelections,
      [articleKey]: nextSelections
    }
  });
}

// Event Bus System - Decoupled component communication
const Bus = {
  listeners: {},
  
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  },
  
  emit(event, data = {}) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Bus event ${event} callback error:`, error);
        }
      });
    }
  },
  
  off(event, callback) {
    if (this.listeners[event]) {
      const index = this.listeners[event].indexOf(callback);
      if (index > -1) {
        this.listeners[event].splice(index, 1);
      }
    }
  }
};

// Centralized App State Management
const App = {
  state: {},
  
  // Initialize state with defaults and migration
  init() {
    this.loadState();
    this.migrateState();
    this.setupStatePersistence();
  },
  
  // Load state from localStorage
  loadState() {
    try {
      const saved = localStorage.getItem('willBuilderState');
      this.state = saved ? JSON.parse(saved) : this.getDefaultState();
    } catch (error) {
      console.warn('Failed to load state, using defaults:', error);
      this.state = this.getDefaultState();
    }
  },
  
  // Save state to localStorage
  saveState() {
    try {
      localStorage.setItem('willBuilderState', JSON.stringify(this.state));
      Bus.emit('state-saved', { state: this.state });
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  },
  
  // Update state and trigger events
  setState(updates) {
    const oldState = { ...this.state };
    this.state = { ...this.state, ...updates };
    this.saveState();
    Bus.emit('state-change', { 
      oldState, 
      newState: this.state, 
      updates 
    });
  },
  
  // Default state structure
  getDefaultState() {
    return {
      version: '1.0',
      currentTab: 'testator',
      livePreview: true,
      intake: {},
      selectedClauses: {},
      nameBank: [],
      preferences: {
        autoSave: true,
        previewSync: true
      }
    };
  },
  
  // State migration for version updates
  migrateState() {
    if (!this.state.version || this.state.version < '1.0') {
      // Migrate legacy intake data
      const legacyIntake = readIntake();
      if (Object.keys(legacyIntake).length > 0) {
        this.state.intake = { ...this.state.intake, ...legacyIntake };
      }
      this.state.version = '1.0';
      this.saveState();
    }
  },
  
  // Auto-save setup
  setupStatePersistence() {
    // Auto-save on state changes - use intake-store for consistency
    Bus.on('form-change', (data) => {
      const updates = {};
      let value = data.value;
      if (data.field === 'ClientMiddleInitialOnly') {
        value = (value === true || value === 'true');
      }
      updates[data.field] = value;

      const nextIntake = { ...this.state.intake, ...updates };
      // Persist intake updates
      writeIntake(updates);

      const currentSelections = this.state.selectedClauses || {};
      const familySelection = currentSelections.family || [];
      const priorAutoFamily = suggestFamilyClauses(this.state.intake || {});
      let autoFamilyApplied = false;
      let nextSelections = currentSelections;

      if (isSelectionAutoManaged(familySelection, priorAutoFamily)) {
        const autoFamily = suggestFamilyClauses(nextIntake);
        if (!arraysEqual(autoFamily, familySelection)) {
          nextSelections = { ...currentSelections, family: autoFamily };
          autoFamilyApplied = true;
        }
      }

      // Also update App.state for internal consistency
      if (autoFamilyApplied) {
        this.setState({ intake: nextIntake, selectedClauses: nextSelections });
      } else {
        this.setState({ intake: nextIntake });
      }
      updateConditionalFields(nextIntake);
      
      // Trigger preview update
      Bus.emit('preview-update');

      if (autoFamilyApplied) {
        syncClauseSelectionUI('family', nextSelections.family);
        updateAddonUI('family');
      }
    });
  }
};

// Reusable importer helpers
App.applyImportedJson = async (data, options = {}) => {
  try {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, message: 'JSON must be an object with key/value pairs.' };
    }

    const canonical = buildCanonicalIntake();
    const allowedKeys = new Set(Object.keys(canonical));

    // Filter incoming object to allowed keys only; keep types as-is
    const filtered = {};
    let copied = 0;
    for (const [k, v] of Object.entries(data)) {
      if (allowedKeys.has(k)) {
        filtered[k] = v;
        copied += 1;
      }
    }

    if (copied === 0 && !Array.isArray(data.NameBank) && !(data.SelectedClauses && typeof data.SelectedClauses === 'object')) {
      const sample = Object.keys(data).slice(0, 5).join(', ');
      return { ok: false, message: 'No recognized intake fields found in the JSON. Sample keys: ' + sample };
    }

    // Bring through special optional payloads even if not in canonical
    const importedNameBank = Array.isArray(data.NameBank) ? data.NameBank : undefined;
    const importedSelections = (data.SelectedClauses && typeof data.SelectedClauses === 'object') ? data.SelectedClauses : undefined;

    // Merge into canonical so that any missing fields reset to defaults
    const nextIntake = { ...canonical, ...filtered };
    if (importedNameBank) {
      nextIntake.NameBank = importedNameBank;
    }

    // Persist intake first
    writeIntake(nextIntake);

    // Apply selected clauses if provided
    const statePatch = { intake: nextIntake };
    if (importedSelections) {
      statePatch.selectedClauses = importedSelections;
    }
    App.setState(statePatch);

    // If NameBank was imported, sync derived counts/flags tied to children
    if (importedNameBank) {
      try { syncChildrenCountWithNameBank(nextIntake, importedNameBank); } catch {}
    }

    // Update conditional fields and re-render current tab and preview
    try { await renderTab(currentArticle); } catch {}
    Bus.emit('preview-update', { source: 'json-import' });

    // Build user feedback
    const unknownKeys = Object.keys(data).filter(k => !allowedKeys.has(k) && k !== 'NameBank' && k !== 'SelectedClauses');
    const src = options.sourceName ? options.sourceName : 'JSON';
    const msgParts = [`Imported ${copied} field${copied === 1 ? '' : 's'} from ${src}.`];
    if (importedNameBank) msgParts.push(`Imported Name Bank (${importedNameBank.length} entries).`);
    if (importedSelections) msgParts.push(`Imported selected clauses.`);
    if (unknownKeys.length) {
      msgParts.push(`Ignored ${unknownKeys.length} unknown key${unknownKeys.length === 1 ? '' : 's'}.`);
    }

    return {
      ok: true,
      copied,
      nameBankCount: importedNameBank ? importedNameBank.length : 0,
      hadSelections: !!importedSelections,
      unknownKeys,
      message: msgParts.join('\n')
    };
  } catch (err) {
    console.error('applyImportedJson failed:', err);
    return { ok: false, message: 'Failed to import JSON. See console for details.' };
  }
};

App.loadIntakeFromUrl = async (url, options = {}) => {
  if (!url) throw new Error('URL is required');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
  const data = await res.json();
  const result = await App.applyImportedJson(data, { sourceName: options.sourceName || url });
  if (result?.message) alert(result.message);
  return result;
};



// Structured Clause Registries - Following old app.js pattern
const Clauses = {
  // Registry cache
  _cache: {},
  
  // Load clause libraries
  async init() {
    await this.loadAllClauseLibraries();
  },
  
  // Load all clause JSON files
  async loadAllClauseLibraries() {
    const libraries = [
      'testator', 'family', 'debts_taxes', 'gifts', 
      'residuary', 'executors', 'powers', 'misc', 'trusts', 'signature'
    ];
    
    for (const lib of libraries) {
      try {
        const response = await fetch(`../shared/clauses-${lib}.json`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        this._cache[lib] = this._buildLibraryEntry(lib, data);
      } catch (error) {
        console.error(`Failed to load clause library: ${lib}`, error);
        this._cache[lib] = Array.isArray(this._cache[lib]) ? this._cache[lib] : [];
      }
    }
  },

  _buildLibraryEntry(lib, data = {}) {
    if (lib === 'debts_taxes' || lib === 'gifts' || lib === 'residuary') {
      return this._buildDebtsLibrary(data);
    }
    if (lib === 'powers' || lib === 'misc') {
      return this._buildExtrasOnlyLibrary(data);
    }
    if (lib === 'trusts') {
      return this._buildTrustsLibrary(data);
    }
    return data.clauses || [];
  },

  _buildDebtsLibrary(data = {}) {
    const primary = (data.primary_select_one || []).map(clause => ({
      ...clause,
      type: clause.type || 'primary',
      category: 'primary_select_one'
    }));
    const extras = (data.extras_multi || []).map(clause => ({
      ...clause,
      type: clause.type || 'addon',
      category: 'extras_multi'
    }));
    const boilerplate = (data.boilerplate_always || []).map(clause => ({
      ...clause,
      type: clause.type || 'always',
      category: 'boilerplate_always'
    }));

    const clauses = [...primary, ...extras, ...boilerplate];
    const legacyMap = new Map();
    clauses.forEach(clause => {
      const legacyIds = clause.legacyIds || [];
      legacyIds.forEach(legacyId => {
        if (!legacyMap.has(legacyId)) {
          legacyMap.set(legacyId, clause.id);
        }
      });
    });

    const defaultPrimaryId = data.default_primary
      || primary.find(clause => clause.default)?.id
      || (primary[0]?.id ?? null);

    if (defaultPrimaryId) {
      primary.forEach(clause => {
        clause.default = clause.id === defaultPrimaryId;
      });
    }

    return {
      clauses,
      primary,
      extras,
      boilerplate,
      legacyMap,
      defaultPrimaryId
    };
  },

  _buildExtrasOnlyLibrary(data = {}) {
    const extras = (data.extras_multi || []).map(clause => ({
      ...clause,
      type: clause.type || 'addon',
      category: 'extras_multi'
    }));
    const boilerplate = (data.boilerplate_always || []).map(clause => ({
      ...clause,
      type: clause.type || 'always',
      category: 'boilerplate_always'
    }));

    const clauses = [...extras, ...boilerplate];

    return {
      clauses,
      primary: [],
      extras,
      boilerplate
    };
  },

  _buildTrustsLibrary(data = {}) {
    const primary = (data.primary_select_one || []).map(clause => ({
      ...clause,
      type: clause.type || 'primary',
      category: 'primary_select_one'
    }));
    const extras = (data.extras_multi || []).map(clause => ({
      ...clause,
      type: clause.type || 'addon',
      category: 'extras_multi'
    }));
    const boilerplate = (data.boilerplate_always || []).map(clause => ({
      ...clause,
      type: clause.type || 'always',
      category: 'boilerplate_always'
    }));

    const clauses = [...primary, ...extras, ...boilerplate];

    const defaultPrimaryId = data.default_primary
      || primary.find(clause => clause.default)?.id
      || (primary[0]?.id ?? null);

    if (defaultPrimaryId) {
      primary.forEach(clause => {
        clause.default = clause.id === defaultPrimaryId;
      });
    }

    return {
      clauses,
      primary,
      extras,
      boilerplate,
      defaultPrimaryId
    };
  },
  
  // Get clauses for specific article
  getForArticle(article) {
    const entry = this._cache[article];
    if (!entry) return [];
    return Array.isArray(entry) ? entry : (entry.clauses || []);
  },
  
  // Find specific clause by ID
  findById(id) {
    for (const [article, clauses] of Object.entries(this._cache)) {
      const clause = clauses.find(c => c.id === id);
      if (clause) return clause;
    }
    return null;
  },
  
  // Get clauses by type (primary, variant, optional)
  getByType(article, type) {
    const clauses = this.getForArticle(article);
    return clauses.filter(c => c.type === type);
  },
  
  // Get clauses by tags
  getByTags(article, tags) {
    const clauses = this.getForArticle(article);
    return clauses.filter(c => 
      tags.some(tag => (c.tags || []).includes(tag))
    );
  },
  
  // Structured registries for each article
  get testator() { return this.getForArticle('testator'); },
  get family() { return this.getForArticle('family'); },
  get debts() {
    const config = this.getDebtsConfig();
    return config.clauses;
  },

  getDebtsConfig() {
    const entry = this._cache['debts_taxes'];
    if (!entry) {
      return { clauses: [], primary: [], extras: [], boilerplate: [], legacyMap: new Map(), defaultPrimaryId: null };
    }
    if (Array.isArray(entry)) {
      const clauses = entry.map(clause => ({ ...clause }));
      const primary = clauses.filter(clause => clause.category === 'primary_select_one' || clause.type === 'primary');
      const extras = clauses.filter(clause => clause.category === 'extras_multi' || clause.type === 'addon');
      const boilerplate = clauses.filter(clause => clause.category === 'boilerplate_always' || clause.type === 'always');
      const defaultPrimaryId = primary.find(clause => clause.default)?.id || (primary[0]?.id ?? null);
      if (defaultPrimaryId) {
        primary.forEach(clause => {
          clause.default = clause.id === defaultPrimaryId;
        });
      }
      return {
        clauses,
        primary,
        extras,
        boilerplate,
        legacyMap: new Map(),
        defaultPrimaryId
      };
    }
    return {
      clauses: entry.clauses || [],
      primary: entry.primary || [],
      extras: entry.extras || [],
      boilerplate: entry.boilerplate || [],
      legacyMap: entry.legacyMap || new Map(),
      defaultPrimaryId: entry.defaultPrimaryId ?? null
    };
  },

  resolveDebtsClauseId(id) {
    const config = this.getDebtsConfig();
    if (config.legacyMap.has(id)) {
      return config.legacyMap.get(id);
    }
    return id;
  },
  get gifts() { return this.getForArticle('gifts'); },
  
  getGiftsConfig() {
    const entry = this._cache['gifts'];
    if (!entry) {
      return { clauses: [], primary: [], extras: [], boilerplate: [], defaultPrimaryId: null };
    }
    if (Array.isArray(entry)) {
      const clauses = entry.map(clause => ({ ...clause }));
      const primary = clauses.filter(clause => clause.category === 'primary_select_one' || clause.type === 'primary');
      const extras = clauses.filter(clause => clause.category === 'extras_multi' || clause.type === 'addon');
      const boilerplate = clauses.filter(clause => clause.category === 'boilerplate_always' || clause.type === 'always');
      const defaultPrimaryId = primary.find(clause => clause.default)?.id || (primary[0]?.id ?? null);
      if (defaultPrimaryId) {
        primary.forEach(clause => {
          clause.default = clause.id === defaultPrimaryId;
        });
      }
      return {
        clauses,
        primary,
        extras,
        boilerplate,
        defaultPrimaryId
      };
    }
    return {
      clauses: entry.clauses || [],
      primary: entry.primary || [],
      extras: entry.extras || [],
      boilerplate: entry.boilerplate || [],
      defaultPrimaryId: entry.defaultPrimaryId ?? null
    };
  },
  
  getPowersConfig() {
    const entry = this._cache['powers'];
    if (!entry) {
      return { clauses: [], primary: [], extras: [], boilerplate: [] };
    }
    if (Array.isArray(entry)) {
      const clauses = entry.map(clause => ({ ...clause }));
      const extras = clauses.filter(clause => clause.category === 'extras_multi' || clause.type === 'addon');
      const boilerplate = clauses.filter(clause => clause.category === 'boilerplate_always' || clause.type === 'always');
      return {
        clauses,
        primary: [],
        extras,
        boilerplate
      };
    }
    return {
      clauses: entry.clauses || [],
      primary: entry.primary || [],
      extras: entry.extras || [],
      boilerplate: entry.boilerplate || []
    };
  },
  
  getMiscConfig() {
    const entry = this._cache['misc'];
    if (!entry) {
      return { clauses: [], primary: [], extras: [], boilerplate: [] };
    }
    if (Array.isArray(entry)) {
      const clauses = entry.map(clause => ({ ...clause }));
      const extras = clauses.filter(clause => clause.category === 'extras_multi' || clause.type === 'addon');
      const boilerplate = clauses.filter(clause => clause.category === 'boilerplate_always' || clause.type === 'always');
      return {
        clauses,
        primary: [],
        extras,
        boilerplate
      };
    }
    return {
      clauses: entry.clauses || [],
      primary: entry.primary || [],
      extras: entry.extras || [],
      boilerplate: entry.boilerplate || []
    };
  },
  
  getTrustsConfig() {
    const entry = this._cache['trusts'];
    if (!entry) {
      return { clauses: [], primary: [], extras: [], boilerplate: [], defaultPrimaryId: null };
    }
    if (Array.isArray(entry)) {
      const clauses = entry.map(clause => ({ ...clause }));
      const primary = clauses.filter(clause => clause.category === 'primary_select_one' || clause.type === 'primary');
      const extras = clauses.filter(clause => clause.category === 'extras_multi' || clause.type === 'addon');
      const boilerplate = clauses.filter(clause => clause.category === 'boilerplate_always' || clause.type === 'always');
      const defaultPrimaryId = entry.default_primary
        || primary.find(clause => clause.default)?.id
        || (primary[0]?.id ?? null);
      if (defaultPrimaryId) {
        primary.forEach(clause => {
          clause.default = clause.id === defaultPrimaryId;
        });
      }
      return {
        clauses,
        primary,
        extras,
        boilerplate,
        defaultPrimaryId
      };
    }
    return {
      clauses: entry.clauses || [],
      primary: entry.primary || [],
      extras: entry.extras || [],
      boilerplate: entry.boilerplate || [],
      defaultPrimaryId: entry.defaultPrimaryId ?? null
    };
  },
  
  get residuary() { return this.getForArticle('residuary'); },
  get executors() { return this.getForArticle('executors'); },
  get powers() {
    const config = this.getPowersConfig();
    return config.clauses;
  },
  get misc() {
    const config = this.getMiscConfig();
    return config.clauses;
  },
  get trusts() {
    const config = this.getTrustsConfig();
    return config.clauses;
  },
  get signature() { return this.getForArticle('signature'); }
};


// Export App and Clauses early to avoid circular dependencies
export { Bus, App, Clauses };

// Build a clauses-only document (unhydrated; placeholders preserved)
// Build a snapshot of the same clauses the preview would render, but without hydrating tokens
function getSelectedClausesSnapshot(sectionKey) {
  const state = App.state.intake || {};
  switch (sectionKey) {
    case 'testator': {
      const idMode = (state.IdMode || 'Simple').toLowerCase();
      const clauses = [];
      if (idMode === 'simple') {
        const simple = Clauses.testator.find(c => c.id === 'testator.declaration.will_title_simple');
        if (simple) clauses.push(simple);
      } else {
        const expanded = Clauses.testator.find(c => c.id === 'testator.declaration.will_title_expanded');
        if (expanded) clauses.push(expanded);
      }
      const revocation = Clauses.testator.find(c => c.id === 'testator.revocation.prior_wills');
      if (revocation) clauses.push(revocation);
      if (state.IncludeCapacity === 'Yes') {
        const capacity = Clauses.testator.find(c => c.id === 'testator.intent.independence');
        if (capacity) clauses.push(capacity);
      }
      const additional = (Clauses.testator || []).filter(c => {
        const sel = App.state.selectedClauses?.testator || [];
        return sel.includes(c.id)
          && !c.id.startsWith('testator.declaration.will_title')
          && c.id !== 'testator.revocation.prior_wills'
          && c.id !== 'testator.intent.independence';
      });
      clauses.push(...additional);
      return clauses;
    }
    case 'family': {
      const selected = App.state.selectedClauses?.family || [];
      const finalSel = (selected && selected.length) ? selected : suggestFamilyClauses(state);
      const set = new Set(finalSel);
      return (Clauses.family || []).filter(c => set.has(c.id));
    }
    case 'debts': {
      const cfg = Clauses.getDebtsConfig();
      const normalized = (App.state.selectedClauses?.debts || [])
        .map(id => Clauses.resolveDebtsClauseId(id))
        .filter(Boolean);
      const primary = cfg.primary.find(c => normalized.includes(c.id))
        || cfg.primary.find(c => c.default)
        || (cfg.defaultPrimaryId ? cfg.primary.find(c => c.id === cfg.defaultPrimaryId) : null)
        || cfg.primary[0] || null;
      const addons = cfg.extras.filter(c => normalized.includes(c.id));
      return [ ...(cfg.boilerplate || []), ...(primary ? [primary] : []), ...addons ];
    }
    case 'gifts': {
      const cfg = Clauses.getGiftsConfig();
      const sel = normalizeArticleSelections('gifts');
      const primary = cfg.primary.find(c => sel.includes(c.id))
        || cfg.primary.find(c => c.default)
        || (cfg.defaultPrimaryId ? cfg.primary.find(c => c.id === cfg.defaultPrimaryId) : null)
        || cfg.primary[0] || null;
      const addons = cfg.extras.filter(c => sel.includes(c.id));
      return [ ...(cfg.boilerplate || []), ...(primary ? [primary] : []), ...addons ];
    }
    case 'residuary': {
      const entry = Clauses._cache?.['residuary'];
      if (entry && !Array.isArray(entry)) {
        const normalized = normalizeArticleSelections('residuary');
        const primary = (entry.primary || []).find(clause => normalized.includes(clause.id))
          || (entry.primary || []).find(clause => clause.default)
          || (entry.primary || [])[0] || null;
        const addons = (entry.extras || []).filter(clause => normalized.includes(clause.id));
        const always = entry.boilerplate || [];
        return [ ...always, ...(primary ? [primary] : []), ...addons ];
      }
      // Legacy: use selected, else first primary
      const selected = App.state.selectedClauses?.residuary || [];
      if (selected.length > 0) {
        return (Clauses.residuary || []).filter(c => selected.includes(c.id));
      }
      const primaries = (Clauses.residuary || []).filter(c => c.type === 'primary');
      return primaries.slice(0, 1);
    }
    case 'executors': {
      const state = App.state.intake || {};
      const selected = App.state.selectedClauses?.executors || [];
      const bondPolicy = state.BondPolicy || 'Bond waived';
      let bondId = 'exec.bond.waived';
      if (bondPolicy === 'Bond required') bondId = 'exec.bond.required';
      else if (bondPolicy === 'Court discretion') bondId = 'exec.bond.court_discretion';
      const compPolicy = state.CompensationPolicy || 'Reasonable compensation allowed';
      let compId = 'exec.compensation.allowed';
      if (compPolicy === 'No extra compensation (expenses only)') compId = 'exec.compensation.waived';
      const voting = state.CoExecutorsActBy || 'Majority';
      let voteId = 'exec.voting.majority';
      if (voting === 'Unanimous') voteId = 'exec.voting.unanimous';
      else if (voting === 'Any one acting alone') voteId = 'exec.voting.independent';
      return (Clauses.executors || []).filter(c =>
        selected.includes(c.id) || c.type === 'primary' || c.id === bondId || c.id === compId || c.id === voteId
      );
    }
    case 'powers': {
      const cfg = Clauses.getPowersConfig();
      const extras = cfg.extras || [];
      const always = cfg.boilerplate || [];
      const existing = App.state.selectedClauses || {};
      const hasManual = Object.prototype.hasOwnProperty.call(existing, 'powers');
      const normalized = normalizeArticleSelections('powers');
      const effectiveIds = hasManual ? normalized : (normalized.length ? normalized : extras.map(c => c.id));
      const chosen = extras.filter(c => effectiveIds.includes(c.id));
      return [...always, ...chosen.length ? chosen : (!hasManual && extras.length ? extras : [])];
    }
    case 'misc': {
      const cfg = Clauses.getMiscConfig();
      const extras = cfg.extras || [];
      const always = cfg.boilerplate || [];
      const existing = App.state.selectedClauses || {};
      const hasManual = Object.prototype.hasOwnProperty.call(existing, 'misc');
      const normalized = normalizeArticleSelections('misc');
      const effectiveIds = hasManual ? normalized : (normalized.length ? normalized : extras.map(c => c.id));
      const chosen = extras.filter(c => effectiveIds.includes(c.id));
      return [...always, ...chosen.length ? chosen : (!hasManual && extras.length ? extras : [])];
    }
    case 'trusts': {
      const cfg = Clauses.getTrustsConfig();
      const primary = (cfg.primary || []);
      const extras = (cfg.extras || []);
      const always = (cfg.boilerplate || []);
      const normalized = normalizeArticleSelections('trusts');
      const selSet = new Set(normalized);
      let chosenPrimary = primary.find(c => selSet.has(c.id))
        || primary.find(c => c.id === cfg.defaultPrimaryId)
        || primary[0] || null;
      const addons = extras.filter(c => selSet.has(c.id));
      const result = [];
      if (chosenPrimary) result.push(chosenPrimary);
      if (addons.length) result.push(...addons);
      if (always.length) result.push(...always);
      return result;
    }
    case 'signature': {
      const selected = App.state.selectedClauses?.signature || [];
      return (Clauses.signature || []).filter(c => selected.includes(c.id) || c.type === 'primary');
    }
    default:
      return [];
  }
}

export function buildClausesOnlyDocument() {
  const sections = [
    { key: 'testator', heading: null },
    { key: 'family', heading: null },
    { key: 'debts', heading: 'ARTICLE I — PAYMENT OF DEBTS, EXPENSES, AND TAXES' },
    { key: 'gifts', heading: 'ARTICLE II — TANGIBLE PERSONAL PROPERTY' },
    { key: 'residuary', heading: 'ARTICLE III — RESIDUARY ESTATE' },
    { key: 'executors', heading: 'ARTICLE IV — EXECUTORS' },
    { key: 'powers', heading: 'ARTICLE V — FIDUCIARY POWERS' },
    { key: 'misc', heading: 'ARTICLE VI — MISCELLANEOUS PROVISIONS' },
    { key: 'trusts', heading: 'ARTICLE VII — TRUST PROVISIONS' },
    { key: 'signature', heading: 'ARTICLE VIII — EXECUTION' }
  ];

  const lines = [];
  lines.push('LAST WILL AND TESTAMENT OF [[ClientFullName]]');
  lines.push('');

  for (const s of sections) {
    const clauses = getSelectedClausesSnapshot(s.key);
    if (!clauses || clauses.length === 0) continue;
    if (s.heading) lines.push(s.heading, '');
    for (const c of clauses) {
      const body = c?.body?.trim();
      if (body) lines.push(body, '');
    }
  }
  return lines.join('\n').trim() + '\n';
}

// Tab Populator Functions - Following old app.js pattern
const TabPopulators = {
  
  // Testator populator - unheaded introduction section
  _tesPopulate() {
    const state = App.state.intake || {};
    const selectedClauses = App.state.selectedClauses?.testator || [];
    
    // Determine which declaration clause to use based on IdMode
  const idMode = (state.IdMode || 'Simple').toLowerCase();
    const includeCapacity = state.IncludeCapacity === 'Yes';
    
    let clauses = [];
    
    // Select appropriate declaration clause based on IdMode
    if (idMode === 'simple') {
      const simpleClause = Clauses.testator.find(c => c.id === 'testator.declaration.will_title_simple');
      if (simpleClause) clauses.push(simpleClause);
    } else {
      const expandedClause = Clauses.testator.find(c => c.id === 'testator.declaration.will_title_expanded');
      if (expandedClause) clauses.push(expandedClause);
    }
    
    // Add revocation clause (always included)
    const revocationClause = Clauses.testator.find(c => c.id === 'testator.revocation.prior_wills');
    if (revocationClause) clauses.push(revocationClause);
    
    // Add capacity clause if requested
    if (includeCapacity) {
      const capacityClause = Clauses.testator.find(c => c.id === 'testator.intent.independence');
      if (capacityClause) clauses.push(capacityClause);
    }
    
    // Add any other selected clauses
    const additionalClauses = Clauses.testator.filter(c => 
      selectedClauses.includes(c.id) && 
      !c.id.startsWith('testator.declaration.will_title') &&
      c.id !== 'testator.revocation.prior_wills' &&
      c.id !== 'testator.intent.independence'
    );
    clauses.push(...additionalClauses);
    
    // Build testator section (unheaded)
    return clauses.map(clause => this._renderClause(clause, state)).join('\n\n');
  },
  
  // Family populator - Unheaded identification section
  _famPopulate() {
    const state = App.state.intake || {};
    const selectedClauses = App.state.selectedClauses?.family || [];
    const selectedSet = new Set(selectedClauses);

    if (selectedSet.size === 0) {
      const autoSuggestions = suggestFamilyClauses(state);
      autoSuggestions.forEach(id => selectedSet.add(id));
    }

    const clauses = Clauses.family.filter(c => selectedSet.has(c.id));

    if (clauses.length === 0) {
      return '<p class="placeholder-content">[Select a family clause to display]</p>';
    }

    let content = '';
    clauses.forEach(clause => {
      content += this._hydrateClause(clause, state) + '\n\n';
    });
    return content.trim();
  },

  // Debts & taxes populator - Article I
  _debPopulate() {
    const state = App.state.intake || {};
    const config = Clauses.getDebtsConfig();
    const rawSelections = App.state.selectedClauses?.debts || [];
    const normalizedSelections = rawSelections
      .map(id => Clauses.resolveDebtsClauseId(id))
      .filter(Boolean);

    const selectedPrimary = config.primary.find(clause => normalizedSelections.includes(clause.id));
    const primaryClause = selectedPrimary
      || config.primary.find(clause => clause.default)
      || (config.defaultPrimaryId ? config.primary.find(clause => clause.id === config.defaultPrimaryId) : null)
      || config.primary[0]
      || null;

    const addonClauses = config.extras.filter(clause => normalizedSelections.includes(clause.id));
    const alwaysClauses = config.boilerplate || [];

    const clausesToRender = [
      ...alwaysClauses,
      ...(primaryClause ? [primaryClause] : []),
      ...addonClauses
    ];

    return this._buildArticle('I', 'PAYMENT OF DEBTS, EXPENSES, AND TAXES', clausesToRender, state);
  },
  
  // Gifts populator - Article II (Tangible Personal Property)
  _gifPopulate() {
    const state = App.state.intake || {};
    const config = Clauses.getGiftsConfig();
    const normalizedSelections = normalizeArticleSelections('gifts');
    
    // Select primary clause
    const selectedPrimary = config.primary.find(clause => normalizedSelections.includes(clause.id));
    const primaryClause = selectedPrimary
      || config.primary.find(clause => clause.default)
      || (config.defaultPrimaryId ? config.primary.find(clause => clause.id === config.defaultPrimaryId) : null)
      || config.primary[0]
      || null;
    
    // Select addon clauses
    const addonClauses = config.extras.filter(clause => normalizedSelections.includes(clause.id));
    const alwaysClauses = config.boilerplate || [];
    
    // Get specific gifts from state
    const specificGifts = state.SpecificGifts || [];
    
    const clausesToRender = [
      ...alwaysClauses,
      ...(primaryClause ? [primaryClause] : []),
      ...addonClauses
    ];
    
    // Build the article with clauses and specific gifts
    const clauseText = clausesToRender
      .map(clause => this._renderClause(clause, state))
      .filter(Boolean)
      .join('\n\n');
    
    const giftsText = specificGifts
      .map(gift => this._renderSpecificGift(gift, state))
      .filter(Boolean)
      .join('\n\n');
    
    // Combine clauses and gifts
    const parts = [clauseText, giftsText].filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : null;
  },
  
  _renderSpecificGift(gift, state) {
    if (!gift) return '';
    
    const giftType = gift.type || 'item';
    const benName = gift.benCustom && gift.benCustom.trim()
      ? gift.benCustom.trim()
      : (() => {
          const nb = state.NameBank || [];
          const hit = nb.find(p => p.id === gift.benRef);
          return hit ? fullName(hit) : '[[BeneficiaryName]]';
        })();
    
    let base = '';
    switch (giftType) {
      case 'cash':
        base = `I give the sum of ${gift.amount || '[[Amount]]'} to ${benName}, if he or she survives me.`;
        break;
      case 'item':
        base = `I give my ${gift.what?.trim() || '[[ItemDescription]]'} to ${benName}, if he or she survives me.`;
        break;
      case 'percent':
        base = `I give ${gift.percent || '[[Percent]]'}% of my tangible personal property to ${benName}, if he or she survives me.`;
        break;
      case 'real_property':
        base = `I give my real property located at ${gift.rpAddr?.trim() || '[[PropertyAddress]]'} to ${benName}, if he or she survives me.`;
        break;
      case 'digital':
        const platform = gift.digPlatform?.trim() || '[[Platform]]';
        const ident = gift.digId?.trim() || '';
        base = `I give my digital asset (${platform}${ident ? ' — ' + ident : ''}) to ${benName}.`;
        break;
      default:
        base = `I give ${gift.otherText?.trim() || '[[GiftText]]'} to ${benName}.`;
    }
    
    let tail = '';
    switch (gift.predecease) {
      case 'per_stirpes':
        tail = ' If such beneficiary does not survive me, this gift shall pass to his or her descendants, per stirpes.';
        break;
      case 'per_capita':
        tail = ' If such beneficiary does not survive me, this gift shall pass to my then living descendants, per capita.';
        break;
      case 'alternates':
        if ((gift.alternates || '').trim()) {
          tail = ` If such beneficiary does not survive me, this gift shall instead pass to ${gift.alternates.trim()}.`;
        }
        break;
      case 'residuary':
        tail = ' If such beneficiary does not survive me, this gift shall lapse to my residuary estate.';
        break;
    }
    
    const note = (gift.notes || '').trim();
    return (base + tail + (note ? ` ${note}` : '')).trim();
  },
  
  // Residuary populator - Article III
  _resPopulate() {
    const state = App.state.intake || {};
    const entry = Clauses._cache['residuary'];
    
    // If it's the new structured format
    if (entry && !Array.isArray(entry)) {
      const normalizedSelections = normalizeArticleSelections('residuary');
      const selectedPrimary = entry.primary?.find(clause => normalizedSelections.includes(clause.id));
      const primaryClause = selectedPrimary
        || entry.primary?.find(clause => clause.default)
        || entry.primary?.[0]
        || null;
      
      const addonClauses = (entry.extras || []).filter(clause => normalizedSelections.includes(clause.id));
      const alwaysClauses = entry.boilerplate || [];
      
      const clausesToRender = [
        ...alwaysClauses,
        ...(primaryClause ? [primaryClause] : []),
        ...addonClauses
      ];
      
      return this._buildArticle('III', 'RESIDUARY ESTATE', clausesToRender, state);
    }
    
    // Legacy format fallback
    const selectedClauses = App.state.selectedClauses?.residuary || [];
    let clauses;
    if (selectedClauses.length > 0) {
      clauses = Clauses.residuary.filter(c => selectedClauses.includes(c.id));
    } else {
      const primaryClauses = Clauses.residuary.filter(c => c.type === 'primary');
      clauses = primaryClauses.slice(0, 1);
    }
    
    return this._buildArticle('III', 'RESIDUARY ESTATE', clauses, state);
  },
  
  // Executors populator - Article IV
  _exePopulate() {
    const state = App.state.intake || {};
    const selectedClauses = App.state.selectedClauses?.executors || [];
    
    // Auto-select bond clause based on BondPolicy dropdown
    const bondPolicy = state.BondPolicy || "Bond waived";
    let bondClauseId = "exec.bond.waived"; // default
    if (bondPolicy === "Bond required") {
      bondClauseId = "exec.bond.required";
    } else if (bondPolicy === "Court discretion") {
      bondClauseId = "exec.bond.court_discretion";
    }
    
    // Auto-select compensation clause based on CompensationPolicy dropdown
    const compensationPolicy = state.CompensationPolicy || "Reasonable compensation allowed";
    let compensationClauseId = "exec.compensation.allowed"; // default
    if (compensationPolicy === "No extra compensation (expenses only)") {
      compensationClauseId = "exec.compensation.waived";
    }
    
    // Auto-select voting clause based on CoExecutorsActBy dropdown
    const votingPolicy = state.CoExecutorsActBy || "Majority";
    let votingClauseId = "exec.voting.majority"; // default
    if (votingPolicy === "Unanimous") {
      votingClauseId = "exec.voting.unanimous";
    } else if (votingPolicy === "Any one acting alone") {
      votingClauseId = "exec.voting.independent";
    }
    
    const clauses = Clauses.executors.filter(c => 
      selectedClauses.includes(c.id) || 
      c.type === 'primary' ||
      c.id === bondClauseId ||
      c.id === compensationClauseId ||
      c.id === votingClauseId
    );
    
    return this._buildArticle('IV', 'EXECUTORS', clauses, state);
  },
  
  // Powers populator - Article V
  _powPopulate() {
    const state = App.state.intake || {};
    const config = Clauses.getPowersConfig();
    const extras = config.extras || [];
    const alwaysClauses = config.boilerplate || [];
    const existingSelections = App.state.selectedClauses || {};
    const hasManualSelection = Object.prototype.hasOwnProperty.call(existingSelections, 'powers');
    const normalizedSelections = normalizeArticleSelections('powers');

    const effectiveIds = hasManualSelection
      ? normalizedSelections
      : (normalizedSelections.length ? normalizedSelections : extras.map(clause => clause.id));

    const selectedExtras = extras.filter(clause => effectiveIds.includes(clause.id));
    let clausesToRender = [...alwaysClauses, ...selectedExtras];

    if (!hasManualSelection && clausesToRender.length === 0 && extras.length) {
      clausesToRender = [...alwaysClauses, ...extras];
    }

    return this._buildArticle('V', 'FIDUCIARY POWERS', clausesToRender, state);
  },

  // Miscellaneous populator - Article VI
  _miscPopulate() {
    const state = App.state.intake || {};
    const config = Clauses.getMiscConfig();
    const extras = config.extras || [];
    const alwaysClauses = config.boilerplate || [];
    const existingSelections = App.state.selectedClauses || {};
    const hasManualSelection = Object.prototype.hasOwnProperty.call(existingSelections, 'misc');
    const normalizedSelections = normalizeArticleSelections('misc');

    const effectiveIds = hasManualSelection
      ? normalizedSelections
      : (normalizedSelections.length ? normalizedSelections : extras.map(clause => clause.id));

    const selectedExtras = extras.filter(clause => effectiveIds.includes(clause.id));
    let clausesToRender = [...alwaysClauses, ...selectedExtras];

    if (!hasManualSelection && clausesToRender.length === 0 && extras.length) {
      clausesToRender = [...alwaysClauses, ...extras];
    }

    return this._buildArticle('VI', 'MISCELLANEOUS PROVISIONS', clausesToRender, state);
  },
  
  // Trusts populator - Article VII
  _truPopulate() {
    const state = App.state.intake || {};
    const config = Clauses.getTrustsConfig();
    const primaryClauses = config.primary || [];
    const extraClauses = config.extras || [];
    const alwaysClauses = config.boilerplate || [];

    if (!primaryClauses.length && !extraClauses.length && !alwaysClauses.length) {
      return '<p class="placeholder-content">[Trust clause library not available]</p>';
    }

    const normalizedSelections = normalizeArticleSelections('trusts');
    const selectedSet = new Set(normalizedSelections);

    let selectedPrimary = primaryClauses.find(clause => selectedSet.has(clause.id))
      || primaryClauses.find(clause => clause.id === config.defaultPrimaryId)
      || primaryClauses[0]
      || null;

    if (selectedPrimary && !selectedSet.has(selectedPrimary.id)) {
      ensureDefaultPrimarySelection('trusts', selectedPrimary.id);
      selectedSet.add(selectedPrimary.id);
    }

    const selectedAddons = extraClauses.filter(clause => selectedSet.has(clause.id));
    const clausesToRender = [];

    if (selectedPrimary) {
      clausesToRender.push(selectedPrimary);
    }
    if (selectedAddons.length) {
      clausesToRender.push(...selectedAddons);
    }
    if (alwaysClauses.length) {
      clausesToRender.push(...alwaysClauses);
    }

    if (!clausesToRender.length) {
      return '<p class="placeholder-content">[Select a trust model to populate Article VII]</p>';
    }

    return this._buildArticle('VII', 'TRUST PROVISIONS', clausesToRender, state);
  },
  
  // Signature populator - Article VIII
  _sigPopulate() {
    const state = App.state.intake || {};
    const selectedClauses = App.state.selectedClauses?.signature || [];
    
    const clauses = Clauses.signature.filter(c => 
      selectedClauses.includes(c.id) || c.type === 'primary'
    );
    
    return this._buildArticle('VIII', 'EXECUTION', clauses, state);
  },
  
  // Helper function to build article structure (content only, no headers)
  _buildArticle(number, title, clauses, state) {
    return clauses
      .map(clause => this._renderClause(clause, state))
      .filter(Boolean)
      .join('\n\n');
  },
  
  // Helper function to hydrate clause placeholders
  _hydrateClause(clause, state) {
    let body = clause.body || '';
    
    // Get derived tokens from state (includes computed values)
    const derivedTokens = deriveTokensFromIntake(state);
    
    const makeTokenSpan = (tokenKey, rawValue) => {
      const fallback = `[[${tokenKey}]]`;
      const resolved = rawValue ?? fallback;
      const isMissing = resolved === fallback || resolved === "";
      const display = isMissing ? fallback : resolved;
      const safeValue = escapeHtml(String(display));
      const className = `token-highlight ${isMissing ? 'token-missing' : 'token-filled'}`;
      return `<span class="${className}" data-token="${tokenKey}">${safeValue}</span>`;
    };

    // Replace placeholders with derived token values
    const placeholders = clause.placeholders || [];
    placeholders.forEach(placeholder => {
      const tokenPattern = new RegExp(`\\[\\[${placeholder}\\]\\]`, 'g');
      const rawValue = derivedTokens[placeholder] ?? state[placeholder];
      const highlighted = makeTokenSpan(placeholder, rawValue);
      body = body.replace(tokenPattern, highlighted);
    });

    // Highlight any remaining placeholders that were not declared
    body = body.replace(/\[\[([A-Za-z0-9_]+)\]\]/g, (_, key) => {
      const rawValue = derivedTokens[key] ?? state[key];
      return makeTokenSpan(key, rawValue);
    });
    
    return body;
  },

  _renderClause(clause, state) {
    const hydrated = this._hydrateClause(clause, state);
    if (!hydrated) return '';
    const segments = hydrated
      .split(/\n{2,}/)
      .map(segment => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) return '';
    const paragraphs = segments
      .map(segment => {
        const inner = segment.replace(/\n/g, '<br>');
        return `<p class="clause-paragraph">${inner}</p>`;
      })
      .join('');
    return `<div class="clause" data-clause-id="${clause.id}">${paragraphs}</div>`;
  }
};

// Export TabPopulators
export { TabPopulators };

// State variables
let currentArticle = "testator";
let livePreview = true;
let currentClauses = [];
let currentClauseIdx = 0;
let debounceTimer;
let previewController = null;

// Core initialization
export async function initApp() {
  // Initialize centralized state first
  App.init();
  
  // Initialize structured clause registries
  await Clauses.init();
  
  await loadManifest();
  await setupEventListeners();
  await setupPreviewController();
  await setupTabs();
  await setupUtilities();
  await setupPreviewActions();
  await setupLetterModal();
  await setupPracticeNotes();
  
  // Load last tab from App.state
  const lastTab = App.state.currentTab || "testator";
  await setActiveTab(lastTab);
  
  // Initialize with any existing intake data
  hydrateFromStorage();
  Bus.emit('preview-update');
}

// Event system setup
async function setupEventListeners() {
  // Preview update events
  Bus.on('preview-update', updatePreview);
  Bus.on('tab-change', (data) => {
    currentArticle = data.tab;
  });
  
  // State change events
  Bus.on('state-change', () => {
    Bus.emit('preview-update');
    updateAddonUI(currentArticle);
  });
}

// Tab setup and navigation
async function setupTabs() {
  const tabContainers = Array.from(document.querySelectorAll('[data-tablist="wizard"]'));
  if (!tabContainers.length) return;

  const markup = TABS.map(t =>
    `<button class="tab" data-key="${t.key}" role="tab" aria-selected="false" tabindex="-1">${t.label}</button>`
  ).join("");

  tabContainers.forEach(container => {
    container.innerHTML = markup;
    container.addEventListener("click", handleTabClick);
    container.addEventListener("keydown", (event) => handleTabKeydown(event, container));
  });
}

function handleTabClick(event) {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  setActiveTab(tab.dataset.key);
}

function handleTabKeydown(event, container) {
  const tabs = Array.from(container.querySelectorAll(".tab"));
  const current = document.activeElement;
  const currentIdx = tabs.indexOf(current);

  if (currentIdx === -1) return;

  switch (event.key) {
    case "ArrowLeft":
      if (currentIdx > 0) {
        event.preventDefault();
        tabs[currentIdx - 1].focus();
      }
      break;
    case "ArrowRight":
      if (currentIdx < tabs.length - 1) {
        event.preventDefault();
        tabs[currentIdx + 1].focus();
      }
      break;
    case "Home":
      event.preventDefault();
      tabs[0].focus();
      break;
    case "End":
      event.preventDefault();
      tabs[tabs.length - 1].focus();
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      current.click();
      break;
    default:
      break;
  }
}

// Utilities menu setup
async function setupUtilities() {
  // Setup legacy utilities (hidden)
  const utilBtn = document.getElementById("utilBtn");
  const utilMenu = document.getElementById("utilMenu");
  
  if (utilBtn && utilMenu) {
    utilBtn.addEventListener("click", () => {
      const isOpen = utilMenu.classList.toggle("open");
      utilBtn.setAttribute("aria-expanded", isOpen);
    });
  }
  
  // Left rail utilities - no dropdown needed anymore
  // Buttons are directly in the left rail cards
  
  // Setup toggle preview handlers for both
  const togglePreview = document.getElementById("togglePreview");
  
  const togglePreviewHandler = () => {
    livePreview = !livePreview;
    debouncedRender();
  };
  
  if (togglePreview) {
    togglePreview.addEventListener("click", togglePreviewHandler);
  }
  
  // Removed floating toggle in left rail; replaced with Clauses Only preview
  
  // Setup import JSON handlers for both
  const importJson = document.getElementById("importJson");
  const importJsonFloating = document.getElementById("importJsonFloating");

  const runJsonImport = async () => {
    // Create a hidden file input on the fly to avoid cluttering DOM
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => {
      try { document.body.removeChild(input); } catch {}
    };

    input.addEventListener('change', async () => {
      try {
        const file = input.files?.[0];
        if (!file) { cleanup(); return; }
        const text = await file.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          alert('That file is not valid JSON.');
          cleanup();
          return;
        }
        const summary = await App.applyImportedJson(data, { sourceName: file.name });
        if (summary?.message) alert(summary.message);
      } catch (err) {
        console.error('Import JSON failed:', err);
        alert('Failed to import JSON. See console for details.');
      } finally {
        cleanup();
      }
    }, { once: true });

    input.click();
  };

  importJson?.addEventListener('click', runJsonImport);
  importJsonFloating?.addEventListener('click', runJsonImport);

  // --- New: IO buttons (Export JSON, Import/Export CSV, Export Text) ---
  const exportJsonBtn = document.getElementById("exportJsonBtn");
  const importCsvBtn = document.getElementById("importCsvBtn");
  const importCsvInput = document.getElementById("importCsvInput");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const exportTextBtn = document.getElementById("exportTextBtn");

  const download = (filename, mime, content) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  exportJsonBtn?.addEventListener('click', () => {
    const current = App.state?.intake ?? {};
    const canonical = buildCanonicalIntake();
    const merged = { ...canonical, ...current };
    download('will-intake.json', 'application/json;charset=utf-8', JSON.stringify(merged, null, 2));
  });

  // Basic CSV conversion of flat key/value pairs from intake; nested objects are JSON-stringified
  const toCsv = (obj = {}) => {
    const rows = Object.entries(obj).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')]);
    const header = 'key,value';
    const body = rows.map(r => r.map(x => '"' + String(x).replaceAll('"', '""') + '"').join(',')).join('\n');
    return header + '\n' + body + '\n';
  };

  exportCsvBtn?.addEventListener('click', () => {
    const current = App.state?.intake ?? {};
    const canonical = buildCanonicalIntake();
    const merged = { ...canonical, ...current };
    download('will-intake.csv', 'text/csv;charset=utf-8', toCsv(merged));
  });

  exportTextBtn?.addEventListener('click', async () => {
    // Export the full letter text if available; fallback to JSON pretty text
    let text = '';
    try {
      const html = await previewController?.renderAll ? previewController.renderAll(App.state.intake) : null;
      // If renderAll returns nothing synchronously, grab the last generated full letter if any
      // As a simple fallback, stringify intake
      text = document.getElementById('preview-content')?.innerText?.trim() || '';
    } catch {}
    if (!text) {
      text = JSON.stringify(App.state?.intake ?? {}, null, 2);
    }
    download('will-export.txt', 'text/plain;charset=utf-8', text);
  });

  // Lightweight export: Clauses Only (unhydrated) with clipboard copy
  const exportClausesOnly = async () => {
    try {
      const text = buildClausesOnlyDocument();
      // Try to copy to clipboard first
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // Fallback for older browsers: temporarily select and copy
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'absolute';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } catch (copyErr) {
        console.warn('Clipboard copy failed; proceeding to download:', copyErr);
      }
      // Then trigger the download
      download('will-clauses-only.txt', 'text/plain;charset=utf-8', text);
    } catch (e) {
      console.error('Failed to export clauses-only:', e);
      alert('Sorry, there was an error creating the clauses-only export.');
    }
  };
  // Expose on App for UI wiring from index.html
  App.exportClausesOnly = exportClausesOnly;

  // In-browser Clauses-by-Tab report generator
  const TAB_ORDER = [
    { key: 'testator', label: 'Testator' },
    { key: 'family', label: 'Family' },
    { key: 'debts', label: 'Debts' },
    { key: 'gifts', label: 'Gifts' },
    { key: 'residuary', label: 'Residuary' },
    { key: 'executors', label: 'Executors' },
    { key: 'powers', label: 'Powers' },
    { key: 'misc', label: 'Misc' },
    { key: 'trusts', label: 'Trusts' },
    { key: 'signature', label: 'Signature' }
  ];

  const tabToArticleKey = (k) => (k === 'debts' ? 'debts_taxes' : k);

  function groupClausesForArticle(articleJson) {
    const sections = [];
    const primary = articleJson.primary_select_one || [];
    const addons = articleJson.extras_multi || [];
    const always = articleJson.boilerplate_always || [];
    const flat = articleJson.clauses || [];

    if (primary.length || addons.length || always.length) {
      sections.push({ key: 'primary', title: 'Primary (select one)', items: primary });
      if (addons.length) sections.push({ key: 'addons', title: 'Add-ons (multi-select)', items: addons });
      if (always.length) sections.push({ key: 'always', title: 'Always Included (boilerplate)', items: always });
    }
    if (flat.length) sections.push({ key: 'clauses', title: 'Clauses', items: flat });

    for (const sec of sections) {
      const bySub = new Map();
      for (const c of sec.items) {
        const sub = c.subheader || '';
        if (!bySub.has(sub)) bySub.set(sub, []);
        bySub.get(sub).push(c);
      }
      sec.subsections = [];
      for (const [sub, list] of bySub.entries()) {
        const byGroup = new Map();
        for (const c of list) {
          const g = c.group || '';
          if (!byGroup.has(g)) byGroup.set(g, []);
          byGroup.get(g).push(c);
        }
        const groups = [];
        for (const [g, glist] of byGroup.entries()) {
          groups.push({ group: g, items: glist });
        }
        sec.subsections.push({ subheader: sub, groups });
      }
    }
    return sections;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function renderHtmlReport(model) {
    const { generatedAt, tabs } = model;
    const css = `
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; line-height: 1.6; max-width: 1200px; margin: 0 auto; padding: 20px; background: #fafafa; }
      .header { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 30px; }
      .metadata { background: #ecf0f1; padding: 15px; border-radius: 6px; margin: 20px 0; font-size: 14px; }
      .tab-section { background: white; margin: 30px 0; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .tab-header { background: #34495e; color: white; padding: 16px 20px; display:flex; align-items:center; justify-content:space-between; }
      .tab-title { margin: 0; font-size: 20px; }
      .section-block { padding: 16px 20px; border-top: 1px solid #ecf0f1; }
      .section-title { margin: 0 0 10px 0; font-weight: 600; color: #2c3e50; }
      .subheader { font-weight: 600; color: #7f8c8d; margin: 8px 0; }
      .group-title { font-weight: 600; color: #9b59b6; margin: 8px 0; }
      .clause { border: 1px solid #ecf0f1; padding: 12px; border-radius: 6px; margin: 8px 0; background:#fdfdfd; }
      .clause-header { display:flex; align-items:flex-start; justify-content:space-between; gap: 12px; }
      .clause-title { margin: 0; font-size: 16px; color: #2c3e50; }
      .clause-id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 12px; background: #ecf0f1; padding: 2px 6px; border-radius: 4px; color: #7f8c8d; }
      .clause-meta { display:flex; flex-wrap:wrap; gap:12px; margin:8px 0; font-size: 13px; color:#555; }
      .badge { background:#3498db; color:white; border-radius: 10px; padding: 0 6px; font-size: 11px; }
      .badge.primary { background:#2ecc71; }
      .badge.addon { background:#f39c12; }
      .badge.variant { background:#9b59b6; }
      .placeholders { font-size:12px; margin-top:6px; color:#856404; }
      .ph { background:#fff3cd; border-radius:3px; padding:0 4px; font-family:monospace; }
      .clause-body { background:#f8f9fa; border-left:4px solid #3498db; padding:8px 10px; border-radius:4px; margin-top:6px; }
      .muted { color:#777; }
    `;

    const toc = tabs
      .map((t) => `<li><a href="#tab-${t.key}">${escapeHtml(t.label)}</a> ${t.articleTitle ? `(${t.clauseCount} items)` : ''}</li>`)
      .join('');

    const sectionsHtml = tabs
      .map((t) => {
        const headerMeta = t.articleTitle ? `${escapeHtml(t.articleTitle)} • ${t.clauseCount} items` : 'No linked article';
        const content = (t.sections || [])
          .map((sec) => {
            const subblocks = sec.subsections
              .map((ss) => {
                const subheader = ss.subheader ? `<div class="subheader">${escapeHtml(ss.subheader)}</div>` : '';
                const groups = ss.groups
                  .map((g) => {
                    const groupTitle = g.group ? `<div class="group-title">Group: ${escapeHtml(g.group)}</div>` : '';
                    const items = g.items
                      .map((c) => {
                        const phs =
                          Array.isArray(c.placeholders) && c.placeholders.length
                            ? `<div class="placeholders">Placeholders: ${c.placeholders
                                .map((p) => `<span class='ph'>[[${escapeHtml(p)}]]</span>`)
                                .join(' ')}</div>`
                            : '';
                        const tags = Array.isArray(c.tags) && c.tags.length ? `Tags: ${c.tags.map(escapeHtml).join(', ')}` : '';
                        const type = c.type ? `<span class="badge ${escapeHtml(c.type)}">${escapeHtml(c.type)}</span>` : '';
                        const metaParts = [type];
                        if (c.group) metaParts.push(`Group: ${escapeHtml(c.group)}`);
                        if (c.maxPerSection) metaParts.push(`Max/Section: ${escapeHtml(c.maxPerSection)}`);
                        if (tags) metaParts.push(tags);
                        const meta =
                          metaParts.filter(Boolean).length ? `<div class="clause-meta">${metaParts.filter(Boolean).join(' • ')}</div>` : '';
                        return `
                          <div class="clause">
                            <div class="clause-header">
                              <h4 class="clause-title">${escapeHtml(c.title || '')}</h4>
                              <div class="clause-id">${escapeHtml(c.id || '')}</div>
                            </div>
                            ${meta}
                            <div class="clause-body">${c.body || ''}</div>
                            ${phs}
                          </div>
                        `;
                      })
                      .join('');
                    return `${groupTitle}${items}`;
                  })
                  .join('');
                return `${subheader}${groups}`;
              })
              .join('');
            return `<div class="section-block"><h3 class="section-title">${escapeHtml(sec.title)}</h3>${subblocks || '<div class="muted">None</div>'}</div>`;
          })
          .join('');

        return `
          <section class="tab-section" id="tab-${t.key}">
            <div class="tab-header">
              <h2 class="tab-title">${escapeHtml(t.label)}</h2>
              <div>${headerMeta}</div>
            </div>
            ${content || '<div class="section-block"><div class="muted">No content</div></div>'}
          </section>
        `;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clause Library — By Tab</title>
  <style>${css}</style>
  </head>
<body>
  <div class="header">
    <h1>Clause Library — By Tab</h1>
    <div class="metadata">
      <strong>Generated:</strong> ${new Date(generatedAt).toLocaleString()}<br/>
      <strong>Tab Count:</strong> ${tabs.length}
    </div>
    <div class="toc">
      <h2>Table of Contents</h2>
      <ul>${toc}</ul>
    </div>
  </div>
  ${sectionsHtml}
</body>
</html>`;
  }

  App.runByTabReport = async () => {
    try {
      // Ensure manifest is available (already loaded in initApp)
      const manifest = await loadManifest();

      const tabsWithArticles = await Promise.all(
        TAB_ORDER.map(async (t) => {
          const key = tabToArticleKey(t.key);
          const entry = manifest.articles.find((a) => a.key === key);
          if (!entry) return { ...t, articleTitle: null, sections: [], clauseCount: 0 };

          const res = await fetch(entry.src.startsWith('/') ? `..${entry.src}` : `../${entry.src}`);
          if (!res.ok) throw new Error(`Failed to load ${entry.src}`);
          const data = await res.json();
          const sections = groupClausesForArticle(data);
          const clauseCount = sections.reduce((acc, s) => acc + (s.items?.length || 0), 0);
          return { ...t, articleTitle: entry.title, sections, clauseCount };
        })
      );

      const html = renderHtmlReport({ generatedAt: new Date().toISOString(), tabs: tabsWithArticles });
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);

      // Download file
      const a = document.createElement('a');
      a.href = url;
      a.download = 'comprehensive-by-tab.html';
      document.body.appendChild(a);
      a.click();
      a.remove();

      // Open in new tab for immediate viewing
      window.open(url, '_blank');

      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('Clauses-by-tab report error:', err);
      alert('Failed to generate the report. Check the console for details.');
    }
  };

  // Import CSV: expects two columns key,value with optional quotes
  const parseCsvPairs = (csv) => {
    const lines = csv.split(/\r?\n/).filter(Boolean);
    if (lines[0]?.toLowerCase().startsWith('key,')) lines.shift();
    const unquote = (s) => s?.replace(/^\"|\"$/g, '').replace(/\"\"/g, '"') ?? '';
    const next = {};
    for (const line of lines) {
      const parts = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
          else { inQ = !inQ; }
        } else if (ch === ',' && !inQ) { parts.push(cur); cur = ''; }
        else { cur += ch; }
      }
      parts.push(cur);
      const key = unquote(parts[0] ?? '').trim();
      let val = unquote(parts[1] ?? '');
      // Try parse JSON values for objects/arrays
      try { val = JSON.parse(val); } catch {}
      if (key) next[key] = val;
    }
    return next;
  };

  importCsvBtn?.addEventListener('click', () => importCsvInput?.click());
  importCsvInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const patch = parseCsvPairs(text);
    App.setState({ intake: { ...App.state.intake, ...patch } });
    // Re-render after import
    debouncedRender();
    e.target.value = '';
  });
}

// Preview controller setup
async function setupPreviewController() {
  previewController = new PreviewController();
  previewController.mount('preview-content', Bus, () => App.state);
  
  // Initial render
  const intake = App.state.intake;
  previewController.renderAll(intake);
}

// Preview actions setup (mobile jump, etc.)
async function setupPreviewActions() {
  // Mobile jump to preview button
  const mobileJumpBtn = document.getElementById("mobileJumpToPreview");
  if (mobileJumpBtn) {
    mobileJumpBtn.addEventListener("click", () => {
      document.getElementById("preview-pane").scrollIntoView({ behavior: 'smooth' });
    });
  }
}

// Letter modal setup
async function setupLetterModal() {
  const letter = document.getElementById("letter");
  let savedScrollPosition = 0;
  
  // Support both left rail and right rail expand buttons
  const expandButtons = [
    document.getElementById("expandLetter"),
    document.getElementById("expandLetterRight")
  ].filter(Boolean);
  
  expandButtons.forEach(btn => {
    btn.addEventListener("click", async () => {
      // Save current preview scroll position
      if (previewController && previewController.container) {
        savedScrollPosition = previewController.container.scrollTop;
      }
      
      await renderFullLetter();
      letter.showModal();
    });
  });
  
  // Mobile terminal button shows terminal-styled preview
  const terminalButton = document.getElementById("expandLetterRightMobile");
  if (terminalButton) {
    terminalButton.addEventListener("click", async () => {
      // Save current preview scroll position
      if (previewController && previewController.container) {
        savedScrollPosition = previewController.container.scrollTop;
      }
      
      await renderTerminalLetter();
      letter.showModal();
    });
  }
  
  const closeModal = () => {
    letter.close();
    
    // Restore preview scroll position after a brief delay
    setTimeout(() => {
      if (previewController && previewController.container) {
        previewController.container.scrollTop = savedScrollPosition;
      }
    }, 100);
  };
  
  document.getElementById("letterClose").addEventListener("click", closeModal);
  letter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // Copy button: copy full letter text content
  const copyBtn = document.getElementById('letterCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        const text = document.getElementById('letterPaper')?.innerText ?? '';
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly',''); ta.style.position='absolute'; ta.style.left='-9999px';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      } catch (err) {
        console.warn('Copy failed:', err);
      }
    });
  }

  // Clauses-only print preview button wiring
  const clausesOnlyBtnLeft = document.getElementById('expandLetterClausesOnly');
  const clausesOnlyBtnRight = document.getElementById('expandLetterClausesOnlyRight');
  const openClausesOnlyPreview = async () => {
      // Save current scroll
      if (previewController && previewController.container) {
        savedScrollPosition = previewController.container.scrollTop;
      }
      // Render clauses-only into letterPaper using same HTML chrome but with placeholders intact
      const letterPaper = document.getElementById('letterPaper');
      if (letterPaper) {
        const text = buildClausesOnlyDocument();
        // Build minimal will-document HTML similar to PreviewController but with raw text paragraphs
        const nameTitle = '[[ClientFullName]]';
        const headerName = nameTitle.toUpperCase();
        const paragraphs = text.split(/\n\n+/).map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
        letterPaper.innerHTML = `
          <div class="will-document">
            <div class="will-header">
              <h1>LAST WILL AND TESTAMENT OF ${headerName}</h1>
            </div>
            <section class="will-article">
              <div class="article-content">${paragraphs}</div>
            </section>
          </div>`;
      }
      letter.showModal();
  };
  clausesOnlyBtnLeft?.addEventListener('click', openClausesOnlyPreview);
  clausesOnlyBtnRight?.addEventListener('click', openClausesOnlyPreview);
}

// Practice Notes setup
async function setupPracticeNotes() {
  const container = document.getElementById('practiceNotesContainer');
  const header = document.getElementById('practiceNotesHeader');
  const toggle = document.getElementById('practiceNotesToggle');
  
  if (!container || !header || !toggle) {
    console.warn('Practice notes elements not found');
    return;
  }

  // Create backdrop element
  const backdrop = document.createElement('div');
  backdrop.className = 'practice-notes-backdrop';
  backdrop.id = 'practiceNotesBackdrop';
  document.body.appendChild(backdrop);

  // Toggle function
  const toggleNotes = () => {
    const isExpanded = container.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', isExpanded);
    backdrop.classList.toggle('active', isExpanded);
  };

  // Click handlers
  header.addEventListener('click', toggleNotes);
  backdrop.addEventListener('click', toggleNotes);

  // Keyboard handler
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && container.classList.contains('expanded')) {
      toggleNotes();
    }
  });
}

// Clause selection rendering
async function renderClauseSelection(articleKey) {
  // Skip clause selection for certain tabs
  if (['testator', 'namebank'].includes(articleKey)) {
    return '';
  }
  
  const clauseRegistry = getClauseRegistry(articleKey);
  if (!clauseRegistry || clauseRegistry.length === 0) {
    return '';
  }

  if (articleKey === 'powers') {
    return renderPowersSelection();
  }
  if (articleKey === 'misc') {
    return renderMiscSelection();
  }
  if (articleKey === 'trusts') {
    return renderTrustsSelection();
  }
  
  const groups = classifyClauses(articleKey);
  const selectedClauses = normalizeArticleSelections(articleKey);
  const selectedSet = new Set(selectedClauses);
  
  // For executors, only show addon clause selection (no primary dropdown)
  if (articleKey === 'executors') {
    return renderAddonOnlySection(articleKey, groups, selectedClauses);
  }

  const primaryOptions = [...groups.primary, ...groups.variant];
  const sortedPrimaryOptions = [...primaryOptions].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const selectedPrimaryFromState = primaryOptions.find(clause => selectedSet.has(clause.id))?.id || "";
  let selectedPrimary = selectedPrimaryFromState;

  let defaultPrimaryClause = sortedPrimaryOptions.find(clause => clause.default);
  if (!defaultPrimaryClause && articleKey === 'debts') {
    defaultPrimaryClause = sortedPrimaryOptions[0] || null;
  }

  if (!selectedPrimary && defaultPrimaryClause) {
    selectedPrimary = defaultPrimaryClause.id;
    ensureDefaultPrimarySelection(articleKey, selectedPrimary);
    selectedSet.add(selectedPrimary);
  }

  const optionsHtml = sortedPrimaryOptions.map(clause => {
    const isSelected = clause.id === selectedPrimary;
    return `<option value="${clause.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(clause.title)}</option>`;
  }).join('');

  const hasAddons = groups.addon.length > 0;
  
  // Get selected addon IDs in order
  const selectedAddonIds = (App.state.selectedClauses?.[articleKey] || [])
    .map(id => resolveClauseId(articleKey, id))
    .filter(id => {
      const clause = groups.addon.find(c => c.id === id);
      return clause !== undefined;
    });
  
  // Render dropdown slots for selected addons
  const addonDropdownsHtml = selectedAddonIds.map((selectedId, idx) => {
    // For each slot, show all addons but:
    // - Selected addon for this slot
    // - Other available addons (not selected in other slots)
    const otherSelectedIds = selectedAddonIds.filter((id, i) => i !== idx);
    const dropdownOptions = groups.addon
      .filter(clause => clause.id === selectedId || !otherSelectedIds.includes(clause.id))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
      .map(clause => {
        const selected = clause.id === selectedId ? 'selected' : '';
        return `<option value="${clause.id}" ${selected}>${escapeHtml(clause.title)}</option>`;
      })
      .join('');
    
    return `
      <div class="addon-dropdown-row" data-addon-index="${idx}">
        <select class="addon-dropdown-select" data-article="${articleKey}" data-addon-index="${idx}">
          ${dropdownOptions}
        </select>
        <button type="button" class="remove-addon-dropdown-btn" data-article="${articleKey}" data-addon-index="${idx}" aria-label="Remove this add-on">×</button>
      </div>
    `;
  }).join('');

  // Get available addons not yet selected
  const availableForNew = groups.addon.filter(clause => !selectedAddonIds.includes(clause.id))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  const addonSectionHtml = hasAddons ? `
      <div class="addon-section">
        <h5>Add-on Clauses</h5>
        <div class="addon-dropdowns-container" data-role="addon-dropdowns">
          ${addonDropdownsHtml || '<p class="muted small addon-empty">No add-on clauses selected.</p>'}
        </div>
        <button type="button" class="add-addon-btn" data-article="${articleKey}" ${availableForNew.length ? '' : 'disabled'}>Add add-on clause</button>
      </div>
    ` : '';
  
  return `
    <div class="clause-selection-panel" data-article="${articleKey}">
      <h4>Select Clauses for ${getTabDisplayName(articleKey)}</h4>
      <select class="clause-select" data-article="${articleKey}">
        ${optionsHtml}
      </select>
      ${addonSectionHtml}
      <p class="muted small">Hold Ctrl (Cmd on Mac) to select multiple clauses.</p>
    </div>
  `;
}

function renderPowersSelection() {
  const config = Clauses.getPowersConfig();
  const extras = config.extras || [];
  if (!extras.length) {
    return '';
  }

  const existingSelections = App.state.selectedClauses || {};
  const hasManualSelection = Object.prototype.hasOwnProperty.call(existingSelections, 'powers');
  const normalizedSelections = normalizeArticleSelections('powers');
  const defaultIds = extras.map(clause => clause.id);
  const activeIds = hasManualSelection
    ? new Set(normalizedSelections)
    : new Set(normalizedSelections.length ? normalizedSelections : defaultIds);

  const checklistHtml = extras.map(clause => {
    const isChecked = activeIds.has(clause.id);
    const bodyId = `powers-body-${clause.id.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase()}`;
    const subhead = clause.subheader ? `<p class="clause-option-subhead">${escapeHtml(clause.subheader)}</p>` : '';
    const tagHtml = (clause.tags || []).slice(0, 4).map(tag => `<span class="clause-option-tag">${escapeHtml(tag)}</span>`).join('');
    const tagsBlock = tagHtml ? `<div class="clause-option-tags">${tagHtml}</div>` : '';
    const cardClasses = ['clause-option'];
    cardClasses.push(isChecked ? 'clause-option--selected' : 'clause-option--deselected');
    return `
      <div class="${cardClasses.join(' ')}" data-clause-id="${clause.id}" data-selected="${isChecked ? 'true' : 'false'}">
        <div class="clause-option-header">
          <button type="button" class="clause-option-main" data-clause-id="${clause.id}" aria-pressed="${isChecked}">
            <span class="clause-option-title">${escapeHtml(clause.title)}</span>
            <span class="clause-option-state">${isChecked ? 'Included' : 'Excluded'}</span>
          </button>
          <button type="button" class="clause-toggle" data-target="${bodyId}" aria-controls="${bodyId}" aria-expanded="false">
            Show clause
          </button>
        </div>
        ${tagsBlock}
        <div class="clause-option-body" id="${bodyId}" hidden>
          ${subhead}
          <p class="clause-option-text">${escapeHtml(clause.body)}</p>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="clause-selection-panel clause-panel-powers" data-article="powers">
      <h4>Select Fiduciary Powers</h4>
      <div class="powers-checklist">
        ${checklistHtml}
      </div>
      <p class="muted small">All powers start enabled. Uncheck any item to omit it from Article V.</p>
    </div>
  `;
}

function renderMiscSelection() {
  const config = Clauses.getMiscConfig();
  const extras = config.extras || [];
  if (!extras.length) {
    return '';
  }

  const existingSelections = App.state.selectedClauses || {};
  const hasManualSelection = Object.prototype.hasOwnProperty.call(existingSelections, 'misc');
  const normalizedSelections = normalizeArticleSelections('misc');
  const defaultIds = extras.map(clause => clause.id);
  const activeIds = hasManualSelection
    ? new Set(normalizedSelections)
    : new Set(normalizedSelections.length ? normalizedSelections : defaultIds);

  const checklistHtml = extras.map(clause => {
    const isChecked = activeIds.has(clause.id);
    const bodyId = `misc-body-${clause.id.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase()}`;
    const subhead = clause.subheader ? `<p class="clause-option-subhead">${escapeHtml(clause.subheader)}</p>` : '';
    const tagHtml = (clause.tags || []).slice(0, 4).map(tag => `<span class="clause-option-tag">${escapeHtml(tag)}</span>`).join('');
    const tagsBlock = tagHtml ? `<div class="clause-option-tags">${tagHtml}</div>` : '';
    const cardClasses = ['clause-option'];
    cardClasses.push(isChecked ? 'clause-option--selected' : 'clause-option--deselected');
    return `
      <div class="${cardClasses.join(' ')}" data-clause-id="${clause.id}" data-selected="${isChecked ? 'true' : 'false'}">
        <div class="clause-option-header">
          <button type="button" class="clause-option-main" data-clause-id="${clause.id}" aria-pressed="${isChecked}">
            <span class="clause-option-title">${escapeHtml(clause.title)}</span>
            <span class="clause-option-state">${isChecked ? 'Included' : 'Excluded'}</span>
          </button>
          <button type="button" class="clause-toggle" data-target="${bodyId}" aria-controls="${bodyId}" aria-expanded="false">
            Show clause
          </button>
        </div>
        ${tagsBlock}
        <div class="clause-option-body" id="${bodyId}" hidden>
          ${subhead}
          <p class="clause-option-text">${escapeHtml(clause.body)}</p>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="clause-selection-panel clause-panel-misc" data-article="misc">
      <h4>Select Miscellaneous Provisions</h4>
      <div class="powers-checklist misc-checklist">
        ${checklistHtml}
      </div>
      <p class="muted small">All provisions start enabled. Uncheck any item to omit it from Article VI.</p>
    </div>
  `;
}

function renderTrustsSelection() {
  const config = Clauses.getTrustsConfig();
  const primary = config.primary || [];
  if (!primary.length) {
    return `
      <div class="clause-selection-panel clause-panel-trusts" data-article="trusts">
        <h4>Trust Provisions</h4>
        <p class="muted small">Trust clause options are not currently available.</p>
      </div>
    `;
  }

  const extras = config.extras || [];
  const normalizedSelections = normalizeArticleSelections('trusts');
  const primaryIds = new Set(primary.map(clause => clause.id));
  let selectedPrimaryId = normalizedSelections.find(id => primaryIds.has(id))
    || config.defaultPrimaryId
    || (primary[0]?.id ?? null);

  if (selectedPrimaryId) {
    ensureDefaultPrimarySelection('trusts', selectedPrimaryId);
  }

  const addonSelections = normalizedSelections.filter(id => extras.some(clause => clause.id === id));
  const intake = readIntake();

  const primaryCardsHtml = primary
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
    .map(clause => buildTrustClauseCard(clause, clause.id === selectedPrimaryId, 'primary'))
    .join('');

  const addonHtml = extras.length ? buildTrustAddonGroups(extras, addonSelections) : '';

  const primaryClause = primary.find(clause => clause.id === selectedPrimaryId) || primary[0] || null;
  const selectedAddonClauses = extras.filter(clause => addonSelections.includes(clause.id));
  const placeholderFieldsHtml = renderTrustPlaceholderFields(intake, primaryClause, selectedAddonClauses);

  return `
    <div class="clause-selection-panel clause-panel-trusts" data-article="trusts">
      <h4>Select Minor Trust Model</h4>
      <div class="trusts-primary-cards">
        ${primaryCardsHtml}
      </div>
      ${extras.length ? '<h5>Optional Trust Add-ons</h5>' : ''}
      ${addonHtml || (extras.length ? '<p class="muted small">Add-on clauses will appear once they are available.</p>' : '')}
      ${placeholderFieldsHtml}
      <p class="muted small">Selections and inputs save automatically.</p>
    </div>
  `;
}

function buildTrustAddonGroups(extras = [], selectedAddonIds = []) {
  if (!extras.length) {
    return '';
  }

  const grouped = extras.reduce((acc, clause) => {
    const key = clause.subheader || 'Additional Clauses';
    if (!acc[key]) acc[key] = [];
    acc[key].push(clause);
    return acc;
  }, {});

  return Object.entries(grouped).map(([heading, clauses]) => {
    const cardsHtml = clauses
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
      .map(clause => buildTrustClauseCard(clause, selectedAddonIds.includes(clause.id), 'addon'))
      .join('');
    return `
      <section class="trusts-addon-group">
        <h6>${escapeHtml(heading)}</h6>
        <div class="trusts-addon-cards">
          ${cardsHtml}
        </div>
      </section>
    `;
  }).join('');
}

function buildTrustClauseCard(clause, isSelected, variant) {
  const bodyId = `trusts-${variant}-${clause.id.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase()}`;
  const subhead = clause.subheader ? `<p class="clause-option-subhead">${escapeHtml(clause.subheader)}</p>` : '';
  const tagHtml = (clause.tags || []).slice(0, 4).map(tag => `<span class="clause-option-tag">${escapeHtml(tag)}</span>`).join('');
  const tagsBlock = tagHtml ? `<div class="clause-option-tags">${tagHtml}</div>` : '';
  const cardClasses = ['clause-option', 'trusts-option'];
  cardClasses.push(variant === 'primary' ? 'trusts-option--primary' : 'trusts-option--addon');
  cardClasses.push(isSelected ? 'clause-option--selected' : 'clause-option--deselected');
  const displayTitle = formatTrustClauseTitle(clause.title || '');
  const titleAttr = clause.title ? ` title="${escapeHtml(clause.title)}"` : '';
  const stateLabel = variant === 'primary'
    ? (isSelected ? 'Primary' : 'Select')
    : (isSelected ? 'Added' : 'Add');

  return `
    <div class="${cardClasses.join(' ')}" data-clause-id="${clause.id}" data-role="trusts-${variant}" data-selected="${isSelected ? 'true' : 'false'}">
      <div class="clause-option-header">
        <button type="button" class="clause-option-main" data-clause-id="${clause.id}" aria-pressed="${isSelected}">
          <span class="clause-option-title"${titleAttr}>${escapeHtml(displayTitle)}</span>
          <span class="clause-option-state">${stateLabel}</span>
        </button>
        <button type="button" class="clause-toggle" data-target="${bodyId}" aria-controls="${bodyId}" aria-expanded="false">
          Show clause
        </button>
      </div>
      ${subhead}
      ${tagsBlock}
      <div class="clause-option-body" id="${bodyId}" hidden>
        <p class="clause-option-text">${escapeHtml(clause.body)}</p>
      </div>
    </div>
  `;
}

function renderTrustPlaceholderFields(intake, primaryClause, addonClauses = []) {
  const placeholders = new Set();
  (primaryClause?.placeholders || []).forEach(name => placeholders.add(name));
  addonClauses.forEach(clause => {
    (clause.placeholders || []).forEach(name => placeholders.add(name));
  });

  if (!placeholders.size) {
    return '<div class="trusts-placeholder-fields"><p class="muted small">No additional inputs are required for the current selections.</p></div>';
  }

  const fieldsHtml = Array.from(placeholders)
    .map(placeholder => renderTrustPlaceholderField(placeholder, intake))
    .filter(Boolean)
    .join('');

  if (!fieldsHtml) {
    return '';
  }

  return `
    <div class="trusts-placeholder-fields">
      <h5>Placeholder Inputs</h5>
      <div class="row">
        ${fieldsHtml}
      </div>
    </div>
  `;
}

function renderTrustPlaceholderField(placeholder, intake = {}) {
  switch (placeholder) {
    case 'MinorTrustAge': {
      const rawValue = intake.MinorTrustAge;
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      return `
        <div class="form-field col-4 trust-field">
          <label for="MinorTrustAge">Minor trust ends at age</label>
          <input type="number" id="MinorTrustAge" class="dynamic-clause-field" data-field="MinorTrustAge" min="18" max="40" step="1" value="${escapeHtml(value)}" placeholder="e.g., 25">
        </div>
      `;
    }
    case 'Age1':
    case 'Age2':
    case 'Age3': {
      const rawValue = intake[placeholder];
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      const label = placeholder === 'Age1' ? 'Stage one distribution age'
        : placeholder === 'Age2' ? 'Stage two distribution age'
        : 'Final distribution age';
      return `
        <div class="form-field col-4 trust-field">
          <label for="${placeholder}">${escapeHtml(label)}</label>
          <input type="number" id="${placeholder}" class="dynamic-clause-field" data-field="${placeholder}" min="18" max="45" step="1" value="${escapeHtml(value)}" placeholder="e.g., 25">
        </div>
      `;
    }
    case 'EducationAge': {
      const rawValue = intake.EducationAge;
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      return `
        <div class="form-field col-4 trust-field">
          <label for="EducationAge">Education trust ends at age</label>
          <input type="number" id="EducationAge" class="dynamic-clause-field" data-field="EducationAge" min="18" max="40" step="1" value="${escapeHtml(value)}" placeholder="e.g., 23">
        </div>
      `;
    }
    case 'DollarThreshold': {
      const rawValue = intake.DollarThreshold;
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      return `
        <div class="form-field col-6 trust-field">
          <label for="DollarThreshold">Small trust termination threshold</label>
          <input type="text" id="DollarThreshold" class="dynamic-clause-field" data-field="DollarThreshold" inputmode="decimal" value="${escapeHtml(value)}" placeholder="e.g., 25000">
        </div>
      `;
    }
    case 'DollarAmount': {
      const rawValue = intake.DollarAmount;
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      return `
        <div class="form-field col-6 trust-field">
          <label for="DollarAmount">Pet trust funding amount</label>
          <input type="text" id="DollarAmount" class="dynamic-clause-field" data-field="DollarAmount" inputmode="decimal" value="${escapeHtml(value)}" placeholder="e.g., 5000">
        </div>
      `;
    }
    case 'TrusteeName': {
      const options = buildTrustNameBankOptions(intake, { roles: ['Trustee'] });
      const selectedId = intake.TrusteeNameSelection || '';
      const manualValue = intake.TrusteeNameManual || intake.TrusteeName || '';
      const optionItems = ['<option value="" data-display="">— Select from Name Bank —</option>']
        .concat(options.map(option => `<option value="${option.id}" data-display="${escapeHtml(option.label)}" ${option.id === selectedId ? 'selected' : ''}>${escapeHtml(option.label)}</option>`))
        .join('');
      return `
        <div class="form-field col-12 trust-field trust-field--name">
          <label for="TrusteeNameManual">Primary trustee</label>
          <div class="trust-name-select">
            <select id="TrusteeNameSelection" class="dynamic-clause-field" data-field="TrusteeNameSelection" data-sync-target="TrusteeNameManual">
              ${optionItems}
            </select>
            <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
          </div>
          <input type="text" id="TrusteeNameManual" class="dynamic-clause-field" data-field="TrusteeNameManual" value="${escapeHtml(String(manualValue))}" placeholder="Enter trustee name">
          <p class="muted small">Choose from the Name Bank or type a custom name.</p>
        </div>
      `;
    }
    case 'AlternateTrusteeList': {
      const options = buildTrustNameBankOptions(intake, { roles: ['Trustee'] });
      const selectedIdsRaw = Array.isArray(intake.AlternateTrusteeListSelection) ? intake.AlternateTrusteeListSelection : [];
      const selectedNames = Array.isArray(intake.AlternateTrusteeList) ? intake.AlternateTrusteeList : [];
      let selectedIds = selectedIdsRaw;
      if (!selectedIds.length && selectedNames.length) {
        selectedIds = options.filter(option => selectedNames.includes(option.label)).map(option => option.id);
      }
      const overrideValue = intake.AlternateTrusteeListOverride || '';
      const size = getTrustMultiSelectSize(options.length);
      const optionItems = options.map(option => {
        const selected = selectedIds.includes(option.id) ? 'selected' : '';
        return `<option value="${option.id}" data-display="${escapeHtml(option.label)}" ${selected}>${escapeHtml(option.label)}</option>`;
      }).join('');
      return `
        <div class="form-field col-12 trust-field trust-field--multi">
          <label for="AlternateTrusteeListSelect">Successor trustees (order)</label>
          <div class="trust-multi-select-group">
            <select id="AlternateTrusteeListSelect" class="dynamic-clause-field trust-multi-select" data-field="AlternateTrusteeListSelection" data-sync-display-field="AlternateTrusteeList" multiple size="${size}">
              ${optionItems}
            </select>
            <div class="trust-name-actions">
              <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
            </div>
          </div>
          <p class="muted small">Selections save in list order. Hold Ctrl (Cmd on Mac) to choose multiple names.</p>
          <textarea id="AlternateTrusteeListOverride" class="dynamic-clause-field" data-field="AlternateTrusteeListOverride" rows="2" placeholder="Override display order (optional)">${escapeHtml(String(overrideValue))}</textarea>
        </div>
      `;
    }
    case 'GuardianName': {
      const options = buildTrustNameBankOptions(intake, { roles: ['Guardian'] });
      const manualValue = intake.GuardianName || '';
      const inferredId = intake.GuardianNameSelection || '';
      const optionItems = ['<option value="" data-display="">— Select from Name Bank —</option>']
        .concat(options.map(option => `<option value="${option.id}" data-display="${escapeHtml(option.label)}" ${option.id === inferredId ? 'selected' : ''}>${escapeHtml(option.label)}</option>`))
        .join('');
      return `
        <div class="form-field col-12 trust-field trust-field--name">
          <label for="GuardianNameInput">Guardian of the person and property</label>
          <div class="trust-name-select">
            <select id="GuardianNameSelection" class="dynamic-clause-field" data-field="GuardianNameSelection" data-sync-target="GuardianNameInput">
              ${optionItems}
            </select>
            <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
          </div>
          <input type="text" id="GuardianNameInput" class="dynamic-clause-field" data-field="GuardianName" value="${escapeHtml(String(manualValue))}" placeholder="Enter guardian name">
        </div>
      `;
    }
    case 'AlternateGuardianList': {
      const options = buildTrustNameBankOptions(intake, { roles: ['Guardian'] });
      const selectedIdsRaw = Array.isArray(intake.AlternateGuardianListSelection) ? intake.AlternateGuardianListSelection : [];
      const selectedNames = Array.isArray(intake.AlternateGuardianList) ? intake.AlternateGuardianList : [];
      let selectedIds = selectedIdsRaw;
      if (!selectedIds.length && selectedNames.length) {
        selectedIds = options.filter(option => selectedNames.includes(option.label)).map(option => option.id);
      }
      const overrideValue = intake.AlternateGuardianListOverride || '';
      const size = getTrustMultiSelectSize(options.length);
      const optionItems = options.map(option => {
        const selected = selectedIds.includes(option.id) ? 'selected' : '';
        return `<option value="${option.id}" data-display="${escapeHtml(option.label)}" ${selected}>${escapeHtml(option.label)}</option>`;
      }).join('');
      return `
        <div class="form-field col-12 trust-field trust-field--multi">
          <label for="AlternateGuardianListSelect">Alternate guardians (order)</label>
          <div class="trust-multi-select-group">
            <select id="AlternateGuardianListSelect" class="dynamic-clause-field trust-multi-select" data-field="AlternateGuardianListSelection" data-sync-display-field="AlternateGuardianList" multiple size="${size}">
              ${optionItems}
            </select>
            <div class="trust-name-actions">
              <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
            </div>
          </div>
          <p class="muted small">Selections save in list order. Provide a custom string below if you need bespoke formatting.</p>
          <textarea id="AlternateGuardianListOverride" class="dynamic-clause-field" data-field="AlternateGuardianListOverride" rows="2" placeholder="Override display order (optional)">${escapeHtml(String(overrideValue))}</textarea>
        </div>
      `;
    }
    case 'RemainderBeneficiary': {
      const options = buildTrustNameBankOptions(intake, { includeCharities: true });
      const selectedId = intake.RemainderBeneficiarySelection || '';
      const manualValue = intake.RemainderBeneficiaryManual || intake.RemainderBeneficiary || '';
      const optionItems = ['<option value="" data-display="">— Select from Name Bank —</option>']
        .concat(options.map(option => `<option value="${option.id}" data-display="${escapeHtml(option.label)}" ${option.id === selectedId ? 'selected' : ''}>${escapeHtml(option.label)}</option>`))
        .join('');
      return `
        <div class="form-field col-12 trust-field trust-field--name">
          <label for="RemainderBeneficiaryManual">Pet trust remainder beneficiary</label>
          <div class="trust-name-select">
            <select id="RemainderBeneficiarySelection" class="dynamic-clause-field" data-field="RemainderBeneficiarySelection" data-sync-target="RemainderBeneficiaryManual">
              ${optionItems}
            </select>
            <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
          </div>
          <input type="text" id="RemainderBeneficiaryManual" class="dynamic-clause-field" data-field="RemainderBeneficiaryManual" value="${escapeHtml(String(manualValue))}" placeholder="Enter beneficiary name">
        </div>
      `;
    }
    default: {
      const rawValue = intake[placeholder];
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      return `
        <div class="form-field col-6 trust-field">
          <label for="${placeholder}">${escapeHtml(formatTrustPlaceholderLabel(placeholder))}</label>
          <input type="text" id="${placeholder}" class="dynamic-clause-field" data-field="${placeholder}" value="${escapeHtml(value)}" placeholder="Enter value">
        </div>
      `;
    }
  }
}

function buildTrustNameBankOptions(intake = {}, { roles = [], includeCharities = false } = {}) {
  const nameBank = Array.isArray(intake.NameBank) ? intake.NameBank : [];
  let candidates = nameBank.filter(entity => {
    if (entity.entityType === 'charity') {
      return includeCharities;
    }
    if (!roles.length) return true;
    const badges = Array.isArray(entity.roles) ? entity.roles : [];
    return roles.some(role => badges.includes(role));
  });

  if (!candidates.length && roles.length) {
    candidates = nameBank.filter(entity => entity.entityType !== 'charity');
  }

  return candidates
    .map(entity => {
      const label = entity.entityType === 'charity'
        ? (entity.charityName || '')
        : (fullName(entity) || '');
      return {
        id: entity.id || '',
        label: label || 'Unnamed Entry',
        entityType: entity.entityType || 'person'
      };
    })
    .filter(option => option.label && option.label.trim().length > 0)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function getTrustMultiSelectSize(optionCount) {
  if (optionCount >= 8) return 8;
  if (optionCount <= 3) return 3;
  return optionCount;
}

function formatTrustPlaceholderLabel(key = '') {
  const spaced = key.replace(/([A-Z])/g, ' $1').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatTrustClauseTitle(title = '') {
  if (!title) return 'Trust Clause';
  let cleaned = title.replace(/\[\[[^\]]+\]\]/g, '...');
  cleaned = cleaned.replace(/\(\s*\.\.\.(?:\s*\/\s*\.\.\.)*\s*\)/g, '');
  cleaned = cleaned.replace(/\(\s*\)/g, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length > 70) {
    cleaned = `${cleaned.slice(0, 67).trim()}...`;
  }
  return cleaned;
}

// Render addon-only section (for executors tab)
function renderAddonOnlySection(articleKey, groups, selectedClauses) {
  const selectedAddonIds = selectedClauses.filter(id => 
    groups.addon.some(c => c.id === id)
  );
  
  const availableAddons = groups.addon.filter(c => !selectedAddonIds.includes(c.id));
  const sortedAvailable = [...availableAddons].sort((a, b) => 
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
  );
  
  let addonDropdownsHtml = '';
  selectedAddonIds.forEach(addonId => {
    const clause = groups.addon.find(c => c.id === addonId);
    if (!clause) return;
    
    const stillAvailable = groups.addon.filter(c => 
      c.id === addonId || !selectedAddonIds.includes(c.id)
    ).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    
    const optionsHtml = stillAvailable.map(c => 
      `<option value="${c.id}" ${c.id === addonId ? 'selected' : ''}>${c.title}</option>`
    ).join('');
    
    addonDropdownsHtml += `
      <div class="addon-dropdown-row" data-clause-id="${addonId}">
        <select class="addon-select" data-article="${articleKey}">
          ${optionsHtml}
        </select>
        <button type="button" class="remove-addon-btn" data-clause-id="${addonId}" title="Remove this clause">×</button>
      </div>
    `;
  });
  
  return `
    <div class="clause-selection-panel" data-article="${articleKey}">
      <h4>Additional Executor Clauses</h4>
      <div class="addon-section">
        <div class="addon-dropdowns-container" data-role="addon-dropdowns">
          ${addonDropdownsHtml || '<p class="muted small addon-empty">No additional clauses selected.</p>'}
        </div>
        <button type="button" class="add-addon-btn" data-article="${articleKey}" ${sortedAvailable.length ? '' : 'disabled'}>Add additional clause</button>
      </div>
    </div>
  `;
}

// Render dynamic fields based on selected clause (for clauses with placeholders)
function renderDynamicClauseFields(articleKey) {
  if (!['residuary', 'executors'].includes(articleKey)) return '';
  
  const intake = readIntake();
  const selectedClauses = normalizeArticleSelections(articleKey);
  const groups = classifyClauses(articleKey);
  const allClauses = [...groups.primary, ...groups.addon, ...groups.variant];
  
  // Find selected clauses that have placeholders or fields
  const selectedClausesWithFields = allClauses.filter(clause => {
    return selectedClauses.includes(clause.id) && 
           (clause.placeholders?.length > 0 || clause.fields?.length > 0);
  });
  
  if (selectedClausesWithFields.length === 0) return '';
  
  let html = '<div class="dynamic-clause-fields">';
  
  selectedClausesWithFields.forEach(clause => {
    // RESIDUARY CLAUSE FIELDS
    // Handle spouse_then_charity - needs single charity selection
    if (clause.id === 'residuary.spouse_then_charity') {
      html += renderCharitySelectionField(intake, 'ResiduaryCharity', 'Backup Charity (if spouse does not survive)');
    }
    
    // Handle backup_charities addon - needs multiple charity selections with percentages
    if (clause.id === 'residuary.addon.backup_charities') {
      html += renderBackupCharitiesField(intake);
    }
    
    // Handle alternates addon - needs multiple person selections
    if (clause.id === 'residuary.addon.alternates') {
      html += renderAlternateBeneficiariesField(intake);
    }
    
    // EXECUTOR CLAUSE FIELDS
    // Handle corporate_backup - needs corporate fiduciary selection
    if (clause.id === 'exec.addon.corporate_backup') {
      html += renderCorporateFiduciaryField(intake);
    }
  });
  
  html += '</div>';
  return html;
}

// Render single charity selection dropdown
function renderCharitySelectionField(intake, fieldId, label) {
  const charities = (intake.NameBank || []).filter(entity => entity.entityType === 'charity');
  const currentValue = intake[fieldId] || '';
  
  if (charities.length === 0) {
    return `
      <div class="form-field col-12 charity-field-empty">
        <label>${escapeHtml(label)}</label>
        <div class="alert alert-warning">
          <p>No charities found in Name Bank.</p>
          <button type="button" class="btn-small go-to-namebank">Go to Name Bank to add a charity</button>
        </div>
      </div>
    `;
  }
  
  const options = ['<option value="">— Select Charity —</option>']
    .concat(charities.map(charity => {
      const name = charity.charityName || 'Unnamed Charity';
      const selected = currentValue === charity.id ? 'selected' : '';
      return `<option value="${charity.id}" ${selected}>${escapeHtml(name)}</option>`;
    }))
    .join('');
  
  return `
    <div class="form-field col-12">
      <label for="${fieldId}">${escapeHtml(label)}</label>
      <select id="${fieldId}" class="dynamic-clause-field" data-field="${fieldId}">
        ${options}
      </select>
    </div>
  `;
}

// Render backup charities list with percentages
function renderBackupCharitiesField(intake) {
  const charities = (intake.NameBank || []).filter(entity => entity.entityType === 'charity');
  const backupCharities = intake.BackupCharities || [];
  
  if (charities.length === 0) {
    return `
      <div class="form-field col-12 charity-field-empty">
        <label>Backup Charities Distribution</label>
        <div class="alert alert-warning">
          <p>No charities found in Name Bank.</p>
          <button type="button" class="btn-small go-to-namebank">Go to Name Bank to add a charity</button>
        </div>
      </div>
    `;
  }
  
  // Calculate current total percentage
  const totalPercent = backupCharities.reduce((sum, entry) => {
    const percent = parseFloat(entry.percentage) || 0;
    return sum + percent;
  }, 0);
  
  const isValid = totalPercent === 100;
  const isOverLimit = totalPercent > 100;
  const statusClass = isValid ? 'valid' : (isOverLimit ? 'error' : 'warning');
  
  let html = `
    <div class="form-field col-12">
      <label>Backup Charities Distribution</label>
      <div class="backup-charities-list" id="backupCharitiesList">
  `;
  
  // Initialize with default 50-50 split if empty
  let entriesToRender = backupCharities;
  if (backupCharities.length === 0) {
    entriesToRender = [
      { charityId: '', percentage: '50.00' },
      { charityId: '', percentage: '50.00' }
    ];
    // Save initial state
    writeIntake({ BackupCharities: entriesToRender });
    App.setState({ intake: { ...App.state.intake, BackupCharities: entriesToRender } });
  }
  
  // Render entries
  entriesToRender.forEach((entry, idx) => {
    html += renderBackupCharityEntry(charities, entry, idx);
  });
  
  html += `
      </div>
      <div class="backup-charity-total ${statusClass}">
        <span class="total-label">Total:</span>
        <span class="total-value" id="backupCharityTotal">${totalPercent.toFixed(2)}%</span>
        <span class="total-remaining">(${(100 - totalPercent).toFixed(2)}% remaining)</span>
      </div>
      <button type="button" class="btn-small add-backup-charity">+ Add Another Charity</button>
      <p class="info-message">💡 Percentages automatically adjust to maintain 100% total when you change any value.</p>
      <p class="error-message" style="display: none;">⚠️ Error message</p>
      <p class="warning-message" style="display: none;">⚠️ Total should equal 100%.</p>
      <p class="unselected-message error-message" style="display: none;">⚠️ Please select a charity for all entries.</p>
    </div>
  `;
  
  return html;
}

// Render single backup charity entry (dropdown + percentage)
function renderBackupCharityEntry(charities, entry, idx) {
  const options = ['<option value="">— Select Charity —</option>']
    .concat(charities.map(charity => {
      const name = charity.charityName || 'Unnamed Charity';
      const selected = entry.charityId === charity.id ? 'selected' : '';
      return `<option value="${charity.id}" ${selected}>${escapeHtml(name)}</option>`;
    }))
    .join('');
  
  return `
    <div class="backup-charity-entry" data-idx="${idx}">
      <select class="backup-charity-select" data-idx="${idx}">
        ${options}
      </select>
      <input type="number" class="backup-charity-percent" data-idx="${idx}" 
             value="${entry.percentage || ''}" 
             placeholder="%" 
             min="0" 
             max="100" 
             step="0.01">
      <span class="percent-symbol">%</span>
      <button type="button" class="btn-small btn-remove remove-backup-charity" data-idx="${idx}">Remove</button>
    </div>
  `;
}

// Render alternate beneficiaries field (multiple person selections)
function renderAlternateBeneficiariesField(intake) {
  // Filter for people (not charities) who have "Beneficiary" role checked
  const people = (intake.NameBank || []).filter(entity => {
    if (entity.entityType === 'charity') return false;
    // Check if they have "Beneficiary" in their roles array
    return Array.isArray(entity.roles) && entity.roles.includes('Beneficiary');
  });
  
  if (people.length === 0) {
    return `
      <div class="form-field col-12">
        <label>Alternate Beneficiaries</label>
        <div class="alert alert-warning">
          <p>⚠️ No beneficiaries found in Name Bank. Please add people with "Beneficiary" role checked.</p>
          <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
        </div>
      </div>
    `;
  }
  
  // Initialize with empty array if not set
  const alternateBeneficiaries = Array.isArray(intake.AlternateBeneficiaries) 
    ? intake.AlternateBeneficiaries 
    : [];
  
  // Always show at least one dropdown
  const entriesToRender = alternateBeneficiaries.length > 0 
    ? alternateBeneficiaries 
    : [{ personId: '' }];
  
  let html = `
    <div class="form-field col-12">
      <label>Alternate Beneficiaries</label>
      <p class="field-hint">Select one or more alternate beneficiaries. They will receive equal shares.</p>
      <div class="alternate-beneficiaries-list">
  `;
  
  // Render each beneficiary dropdown
  entriesToRender.forEach((entry, idx) => {
    html += renderAlternateBeneficiaryEntry(people, entry, idx);
  });
  
  html += `
      </div>
      <button type="button" class="btn-small add-alternate-beneficiary">+ Add Another Beneficiary</button>
    </div>
  `;
  
  return html;
}

// Render single alternate beneficiary entry
function renderAlternateBeneficiaryEntry(people, entry, idx) {
  const options = ['<option value="">— Select Person —</option>']
    .concat(people.map(person => {
      const name = fullName(person) || 'Unnamed Person';
      const selected = entry.personId === person.id ? 'selected' : '';
      return `<option value="${person.id}" ${selected}>${escapeHtml(name)}</option>`;
    }))
    .join('');
  
  return `
    <div class="alternate-beneficiary-entry" data-idx="${idx}">
      <select class="alternate-beneficiary-select" data-idx="${idx}">
        ${options}
      </select>
      <button type="button" class="btn-small btn-remove remove-alternate-beneficiary" data-idx="${idx}">Remove</button>
    </div>
  `;
}

// Render alternate executors field (multiple person selections)
function renderAlternateExecutorsField(intake) {
  // Filter for people with "Executor" role
  const people = (intake.NameBank || []).filter(entity => {
    if (entity.entityType === 'charity') return false;
    return Array.isArray(entity.roles) && entity.roles.includes('Executor');
  });
  
  if (people.length === 0) {
    return `
      <div class="form-field col-12">
        <label>Alternate Executors</label>
        <div class="alert alert-warning">
          <p>⚠️ No people with "Executor" role found in Name Bank. Please add people and assign them the "Executor" role.</p>
          <button type="button" class="btn-small go-to-namebank">Go to Name Bank</button>
        </div>
      </div>
    `;
  }
  
  // Initialize with empty array if not set
  const alternateExecutors = Array.isArray(intake.AlternateExecutors) 
    ? intake.AlternateExecutors 
    : [];
  
  let html = `
    <div class="form-field col-12">
      <label>Alternate Executors</label>
      <p class="field-hint">Click below to add alternate executors. They will serve in the order listed if the primary is unable or unwilling to serve.</p>
      <div class="alternate-executors-list" id="alternateExecutorsList">
  `;
  
  // Render each executor dropdown (only if they exist)
  if (alternateExecutors.length > 0) {
    alternateExecutors.forEach((entry, idx) => {
      html += renderAlternateExecutorEntry(people, entry, idx);
    });
  }
  
  html += `
      </div>
      <button type="button" class="btn-small add-alternate-executor">+ Add Alternate Executor</button>
    </div>
  `;
  
  return html;
}

// Render single alternate executor entry
function renderAlternateExecutorEntry(people, entry, idx) {
  const options = ['<option value="">— Select Person —</option>']
    .concat(people.map(person => {
      const name = fullName(person) || 'Unnamed Person';
      const selected = entry.personId === person.id ? 'selected' : '';
      return `<option value="${person.id}" ${selected}>${escapeHtml(name)}</option>`;
    }))
    .join('');
  
  return `
    <div class="alternate-executor-entry" data-idx="${idx}">
      <select class="alternate-executor-select" data-idx="${idx}">
        ${options}
      </select>
      <button type="button" class="btn-small btn-remove remove-alternate-executor" data-idx="${idx}">Remove</button>
    </div>
  `;
}

// Render corporate fiduciary selection field
function renderCorporateFiduciaryField(intake) {
  const corporateFiduciaries = (intake.NameBank || []).filter(entity => {
    return Array.isArray(entity.roles) && entity.roles.includes('Corporate Fiduciary');
  });
  const currentValue = intake.CorporateFiduciaryName || '';
  
  if (corporateFiduciaries.length === 0) {
    return `
      <div class="form-field col-12 corporate-field-empty">
        <label>Corporate Fiduciary</label>
        <div class="alert alert-warning">
          <p>No corporate fiduciaries found in Name Bank.</p>
          <button type="button" class="btn-small go-to-namebank">Go to Name Bank to add a corporate fiduciary</button>
        </div>
      </div>
    `;
  }
  
  const options = ['<option value="">— Select Corporate Fiduciary —</option>']
    .concat(corporateFiduciaries.map(corp => {
      // Corporate fiduciaries store name in charityName field
      const name = corp.charityName || corp.first || 'Unnamed Corporate Fiduciary';
      const selected = currentValue === corp.id ? 'selected' : '';
      return `<option value="${corp.id}" ${selected}>${escapeHtml(name)}</option>`;
    }))
    .join('');
  
  return `
    <div class="form-field col-12">
      <label for="CorporateFiduciaryName">Corporate Fiduciary</label>
      <select id="CorporateFiduciaryName" class="dynamic-clause-field" data-field="CorporateFiduciaryName">
        ${options}
      </select>
    </div>
  `;
}

// Get clause registry for article
function getClauseRegistry(articleKey) {
  switch (articleKey) {
    case 'family': return Clauses.family;
    case 'debts': return Clauses.debts;
    case 'gifts': return Clauses.gifts;
    case 'residuary': return Clauses.residuary;
    case 'executors': return Clauses.executors;
    case 'powers': return Clauses.powers;
    case 'misc': return Clauses.misc;
    case 'trusts': return Clauses.trusts;
    case 'signature': return Clauses.signature;
    default: return null;
  }
}

function classifyClauses(articleKey) {
  const registry = getClauseRegistry(articleKey) || [];
  const groups = { primary: [], variant: [], addon: [], always: [], all: registry };

  if (articleKey === 'debts') {
    const config = Clauses.getDebtsConfig();
    groups.primary = [...config.primary];
    groups.variant = [];
    groups.addon = [...config.extras];
    groups.always = [...config.boilerplate];
    groups.all = config.clauses;
    return groups;
  }

  if (articleKey === 'gifts') {
    const config = Clauses.getGiftsConfig();
    groups.primary = [...config.primary];
    groups.variant = [];
    groups.addon = [...config.extras];
    groups.always = [...config.boilerplate];
    groups.all = config.clauses;
    return groups;
  }

  if (articleKey === 'trusts') {
    const config = Clauses.getTrustsConfig();
    groups.primary = [...config.primary];
    groups.variant = [];
    groups.addon = [...config.extras];
    groups.always = [...config.boilerplate];
    groups.all = config.clauses;
    return groups;
  }

  if (articleKey === 'residuary') {
    const entry = Clauses._cache['residuary'];
    if (entry && !Array.isArray(entry)) {
      groups.primary = [...(entry.primary || [])];
      groups.variant = [];
      groups.addon = [...(entry.extras || [])];
      groups.always = [...(entry.boilerplate || [])];
      groups.all = entry.clauses || [];
      return groups;
    }
  }

  registry.forEach(clause => {
    if (clause.type === "addon") {
      groups.addon.push(clause);
    } else if (clause.type === "variant") {
      groups.variant.push(clause);
    } else if (clause.type === "always") {
      groups.always.push(clause);
    } else {
      groups.primary.push(clause);
    }
  });
  return groups;
}

function isAddonClause(articleKey, clauseId) {
  const registry = getClauseRegistry(articleKey) || [];
  const resolvedId = resolveClauseId(articleKey, clauseId);
  const clause = registry.find(entry => entry.id === resolvedId);
  return clause ? clause.type === "addon" : false;
}

function updateAddonUI(articleKey) {
  const panel = document.querySelector(`.clause-selection-panel[data-article="${articleKey}"]`);
  if (!panel) return;

  const groups = classifyClauses(articleKey);
  if (!groups.addon.length) return;

  const selectedIdsRaw = App.state.selectedClauses?.[articleKey] || [];
  const selectedAddonIds = selectedIdsRaw
    .map(id => resolveClauseId(articleKey, id))
    .filter(id => {
      const clause = groups.addon.find(c => c.id === id);
      return clause !== undefined;
    });

  // Render dropdown rows for each selected addon
  const dropdownsContainer = panel.querySelector('[data-role="addon-dropdowns"]');
  if (dropdownsContainer) {
    if (selectedAddonIds.length) {
      const dropdownsHtml = selectedAddonIds.map((selectedId, idx) => {
        // For each slot, show all addons except those selected in OTHER slots
        const otherSelectedIds = selectedAddonIds.filter((id, i) => i !== idx);
        const dropdownOptions = groups.addon
          .filter(clause => clause.id === selectedId || !otherSelectedIds.includes(clause.id))
          .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
          .map(clause => {
            const selected = clause.id === selectedId ? 'selected' : '';
            return `<option value="${clause.id}" ${selected}>${escapeHtml(clause.title)}</option>`;
          })
          .join('');
        
        return `
          <div class="addon-dropdown-row" data-addon-index="${idx}">
            <select class="addon-dropdown-select" data-article="${articleKey}" data-addon-index="${idx}">
              ${dropdownOptions}
            </select>
            <button type="button" class="remove-addon-dropdown-btn" data-article="${articleKey}" data-addon-index="${idx}" aria-label="Remove this add-on">×</button>
          </div>
        `;
      }).join('');
      dropdownsContainer.innerHTML = dropdownsHtml;
    } else {
      dropdownsContainer.innerHTML = '<p class="muted small addon-empty">No add-on clauses selected.</p>';
    }
  }

  // Update "Add" button state
  const availableForNew = groups.addon.filter(clause => !selectedAddonIds.includes(clause.id));
  const addButton = panel.querySelector('.add-addon-btn');
  if (addButton) {
    addButton.disabled = availableForNew.length === 0;
  }

  syncClauseSelectionUI(articleKey, selectedAddonIds);
  bindAddonControls(panel);
}

function bindAddonControls(panel) {
  if (!panel || panel.dataset.addonBound === 'true') return;
  panel.dataset.addonBound = 'true';
  const articleKey = panel.dataset.article;

  panel.addEventListener('click', (event) => {
    // Handle "Add add-on clause" button
    const addBtn = event.target.closest('.add-addon-btn');
    if (addBtn) {
      if (addBtn.disabled) return;
      
      // Add a new dropdown slot with first available addon
      const groups = classifyClauses(articleKey);
      const existingSelections = App.state.selectedClauses || {};
      const currentList = existingSelections[articleKey] || [];
      
      // Separate primary and addon clauses
      const allNormalized = currentList.map(id => resolveClauseId(articleKey, id)).filter(Boolean);
      const primaryClauses = allNormalized.filter(id => !isAddonClause(articleKey, id));
      const addonClauses = allNormalized.filter(id => isAddonClause(articleKey, id));
      
      // Find first available addon not already selected
      const availableAddons = groups.addon
        .filter(clause => !addonClauses.includes(clause.id))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      
      if (availableAddons.length > 0) {
        // Combine primary, existing addons, and new addon
        const nextList = [...primaryClauses, ...addonClauses, availableAddons[0].id];
        App.setState({
          selectedClauses: {
            ...existingSelections,
            [articleKey]: nextList
          }
        });
        syncClauseSelectionUI(articleKey, nextList);
        updateAddonUI(articleKey);
        
        // Re-render dynamic fields if this is residuary tab
        if (articleKey === 'residuary') {
          renderTab(currentArticle);
        }
      }
      return;
    }

    // Handle remove button on dropdown row
    const removeBtn = event.target.closest('.remove-addon-dropdown-btn');
    if (removeBtn) {
      const addonIndex = parseInt(removeBtn.dataset.addonIndex);
      const groups = classifyClauses(articleKey);
      const existingSelections = App.state.selectedClauses || {};
      const currentList = existingSelections[articleKey] || [];
      
      // Separate primary and addon clauses
      const allNormalized = currentList.map(id => resolveClauseId(articleKey, id)).filter(Boolean);
      const primaryClauses = allNormalized.filter(id => !isAddonClause(articleKey, id));
      const addonClauses = allNormalized.filter(id => isAddonClause(articleKey, id));
      
      // Remove the addon at this index
      const updatedAddons = addonClauses.filter((id, idx) => idx !== addonIndex);
      
      // Combine primary and remaining addons
      const nextList = [...primaryClauses, ...updatedAddons];
      
      App.setState({
        selectedClauses: {
          ...existingSelections,
          [articleKey]: nextList
        }
      });
      syncClauseSelectionUI(articleKey, nextList);
      updateAddonUI(articleKey);
      
      // Re-render dynamic fields if this is residuary tab
      if (articleKey === 'residuary') {
        renderTab(currentArticle);
      }
    }
  });

  panel.addEventListener('change', (event) => {
    const select = event.target;
    if (!select.matches('.addon-dropdown-select')) return;
    
    const addonIndex = parseInt(select.dataset.addonIndex);
    const newClauseId = select.value;
    if (!newClauseId) return;

    const existingSelections = App.state.selectedClauses || {};
    const currentList = existingSelections[articleKey] || [];
    
    // Separate primary and addon clauses
    const allNormalized = currentList.map(id => resolveClauseId(articleKey, id)).filter(Boolean);
    const primaryClauses = allNormalized.filter(id => !isAddonClause(articleKey, id));
    const addonClauses = allNormalized.filter(id => isAddonClause(articleKey, id));
    
    // Replace the addon at this index
    const updatedAddons = [...addonClauses];
    updatedAddons[addonIndex] = newClauseId;
    
    // Combine primary and updated addons
    const nextList = [...primaryClauses, ...updatedAddons];
    
    App.setState({
      selectedClauses: {
        ...existingSelections,
        [articleKey]: nextList
      }
    });
    syncClauseSelectionUI(articleKey, nextList);
    updateAddonUI(articleKey);
    
    // Re-render dynamic fields if this is residuary or executors tab
    if (articleKey === 'residuary' || articleKey === 'executors') {
      renderTab(currentArticle);
    }
  });
}

function bindPowersChecklist(panel) {
  if (!panel || panel.dataset.article !== 'powers' || panel.dataset.powersBound === 'true') {
    return;
  }

  panel.dataset.powersBound = 'true';

  panel.addEventListener('click', (event) => {
    const toggle = event.target.closest('.clause-toggle');
    if (toggle) {
      const targetId = toggle.dataset.target;
      if (!targetId) return;
      const body = panel.querySelector(`#${targetId}`);
      if (!body) return;

      const isHidden = body.hasAttribute('hidden');
      if (isHidden) {
        body.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Hide clause';
      } else {
        body.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Show clause';
      }
      return;
    }

    const card = event.target.closest('.clause-option');
    if (!card) return;
    if (event.target.closest('.clause-option-body')) return;

    const clauseId = card.dataset.clauseId;
    if (!clauseId) return;

    const mainToggle = card.querySelector('.clause-option-main');

    const nextSelected = card.dataset.selected !== 'true';
    card.dataset.selected = nextSelected ? 'true' : 'false';
    card.classList.toggle('clause-option--selected', nextSelected);
    card.classList.toggle('clause-option--deselected', !nextSelected);
    if (mainToggle) {
      mainToggle.setAttribute('aria-pressed', String(nextSelected));
    }

    const stateLabel = card.querySelector('.clause-option-state');
    if (stateLabel) {
      stateLabel.textContent = nextSelected ? 'Included' : 'Excluded';
    }

    const config = Clauses.getPowersConfig();
    const allowedIds = new Set((config.extras || []).map(clause => clause.id));

    const selectedIds = Array.from(panel.querySelectorAll('.clause-option[data-clause-id][data-selected="true"]'))
      .map(node => node.dataset.clauseId)
      .filter(id => allowedIds.has(id));

    const existingSelections = App.state.selectedClauses || {};
    App.setState({
      selectedClauses: {
        ...existingSelections,
        powers: selectedIds
      }
    });

    Bus.emit('preview-update');
  });
}

function bindMiscChecklist(panel) {
  if (!panel || panel.dataset.article !== 'misc' || panel.dataset.miscBound === 'true') {
    return;
  }

  panel.dataset.miscBound = 'true';

  panel.addEventListener('click', (event) => {
    const toggle = event.target.closest('.clause-toggle');
    if (toggle) {
      const targetId = toggle.dataset.target;
      if (!targetId) return;
      const body = panel.querySelector(`#${targetId}`);
      if (!body) return;

      const isHidden = body.hasAttribute('hidden');
      if (isHidden) {
        body.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Hide clause';
      } else {
        body.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Show clause';
      }
      return;
    }

    const card = event.target.closest('.clause-option');
    if (!card) return;
    if (event.target.closest('.clause-option-body')) return;

    const clauseId = card.dataset.clauseId;
    if (!clauseId) return;

    const mainToggle = card.querySelector('.clause-option-main');

    const nextSelected = card.dataset.selected !== 'true';
    card.dataset.selected = nextSelected ? 'true' : 'false';
    card.classList.toggle('clause-option--selected', nextSelected);
    card.classList.toggle('clause-option--deselected', !nextSelected);
    if (mainToggle) {
      mainToggle.setAttribute('aria-pressed', String(nextSelected));
    }

    const stateLabel = card.querySelector('.clause-option-state');
    if (stateLabel) {
      stateLabel.textContent = nextSelected ? 'Included' : 'Excluded';
    }

    const config = Clauses.getMiscConfig();
    const allowedIds = new Set((config.extras || []).map(clause => clause.id));

    const selectedIds = Array.from(panel.querySelectorAll('.clause-option[data-clause-id][data-selected="true"]'))
      .map(node => node.dataset.clauseId)
      .filter(id => allowedIds.has(id));

    const existingSelections = App.state.selectedClauses || {};
    App.setState({
      selectedClauses: {
        ...existingSelections,
        misc: selectedIds
      }
    });

    Bus.emit('preview-update');
  });
}

function bindTrustsPanel(panel) {
  if (!panel || panel.dataset.article !== 'trusts' || panel.dataset.trustsBound === 'true') {
    return;
  }

  panel.dataset.trustsBound = 'true';

  panel.addEventListener('click', async (event) => {
    const toggle = event.target.closest('.clause-toggle');
    if (toggle) {
      const targetId = toggle.dataset.target;
      if (!targetId) return;
      const body = panel.querySelector(`#${targetId}`);
      if (!body) return;

      const isHidden = body.hasAttribute('hidden');
      if (isHidden) {
        body.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Hide clause';
      } else {
        body.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Show clause';
      }
      return;
    }

    const card = event.target.closest('.trusts-option');
    if (!card) return;
    if (event.target.closest('.clause-option-body')) return;

    const clauseId = card.dataset.clauseId;
    const role = card.dataset.role;
    if (!clauseId || !role) return;

    const config = Clauses.getTrustsConfig();
    const existingSelections = App.state.selectedClauses || {};
    const currentList = existingSelections.trusts || [];
    const normalized = currentList
      .map(id => resolveClauseId('trusts', id))
      .filter(Boolean);

    const primaryIds = new Set((config.primary || []).map(clause => clause.id));
    const addonIds = new Set((config.extras || []).map(clause => clause.id));
    let primaryId = normalized.find(id => primaryIds.has(id))
      || config.defaultPrimaryId
      || (config.primary?.[0]?.id ?? null);
    let addonSelections = normalized.filter(id => addonIds.has(id));

    if (role === 'trusts-primary') {
      if (clauseId === primaryId) return;
      primaryId = clauseId;
    } else if (role === 'trusts-addon') {
      if (!addonIds.has(clauseId)) return;
      const isSelected = card.dataset.selected === 'true';
      if (isSelected) {
        addonSelections = addonSelections.filter(id => id !== clauseId);
      } else {
        addonSelections = addonSelections.concat(clauseId).filter((id, index, arr) => arr.indexOf(id) === index);
      }
    } else {
      return;
    }

    const nextSelections = primaryId
      ? [primaryId, ...addonSelections]
      : [...addonSelections];

    App.setState({
      selectedClauses: {
        ...existingSelections,
        trusts: nextSelections
      }
    });

    if (currentArticle === 'trusts') {
      await renderTab('trusts');
    }
  });
}

// Main tab rendering function
export async function renderTab(articleKey) {
  const intake = readIntake();
  const formDef = FORM[articleKey];
  
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) {
    console.error("Tab content container not found");
    return;
  }
  
  if (!formDef) {
    tabContent.innerHTML = `<p>Tab "${articleKey}" not yet implemented.</p>`;
    return;
  }
  
  const clauseSelectionHtml = await renderClauseSelection(articleKey);
  const dynamicFieldsHtml = renderDynamicClauseFields(articleKey);
  
  // For gifts tab, render clause selection first, then gifts manager
  const isGiftsTab = articleKey === 'gifts';
  const isResiduaryTab = articleKey === 'residuary';
  
  const html = isGiftsTab
    ? `
      ${clauseSelectionHtml}
      <div class="row">
        ${formDef.map(item => renderFormItem(item, intake)).join("")}
      </div>
      <p class="muted">Form updates are automatically saved and preview updates after a short pause.</p>
    `
    : isResiduaryTab
    ? `
      <div class="row">
        ${formDef.map(item => renderFormItem(item, intake)).join("")}
      </div>
      ${clauseSelectionHtml}
      ${dynamicFieldsHtml}
      <p class="muted">Form updates are automatically saved and preview updates after a short pause.</p>
    `
    : `
      <div class="row">
        ${formDef.map(item => renderFormItem(item, intake)).join("")}
      </div>
      ${clauseSelectionHtml}
      ${dynamicFieldsHtml}
      <p class="muted">Form updates are automatically saved and preview updates after a short pause.</p>
    `;
  
  tabContent.innerHTML = html;
  
  // Bind all inputs after rendering
  bindFormEvents();
  updateConditionalFields(intake);
  updateAddonUI(articleKey);
}

// Render individual form items
function renderFormItem(item, intake) {
  switch (item.type) {
    case "section":
      return `<div class="col-12"><h3>${item.legend}</h3></div>`;

    case "subsection":
      return `<div class="col-12"><h4>${item.legend}</h4></div>`;

    case "hint":
      return `<div class="col-12"><p class="muted">${item.text}</p></div>`;

    case "placeholder":
      return `<div class="col-12"><p class="muted" style="font-style:italic;">${item.text}</p></div>`;

    case "row":
      return item.fields.map(field => renderField(field, intake)).join("");

    case "checks":
    case "checks-2col":
    case "checks-inline":
      return renderChecks(item, intake);

    case "radio":
      return renderRadio(item, intake);

    case "repeat":
      return renderRepeat(item, intake);

    case "namebank":
      return renderNameBank(intake);

    case "family-tree":
      return renderFamilyTree(intake);

    case "gifts-manager":
      return renderGiftsManager(intake);

    case "alternate-executors":
      return renderAlternateExecutorsField(intake);

    default:
      return "";
  }
}

function renderField(field, intake) {
  const rawValue = intake?.[field.id];
  const value = rawValue !== undefined ? rawValue : field.value;
  const isToggleExtra = field.as === "toggle-extra";
  const displayLabel = field.displayLabel !== undefined ? field.displayLabel : (isToggleExtra ? "" : field.label);
  const hasLabel = Boolean(displayLabel) && field.as !== "static" && field.as !== "checkbox" && (!isToggleExtra || field.displayLabel !== undefined);
  const attrs = getFieldAttributes(field);
  const conditionAttrs = buildConditionAttributes(field.showWhen);
  const colClass = field.col ? `col-${field.col}` : "col-12";
  const wrapperClasses = [colClass, field.wrapperClass, "form-field"].filter(Boolean);

  let input = "";

  switch (field.as) {
    case "text":
      input = `<input type="text" id="${field.id}" value="${escapeHtml(String(value ?? ""))}" ${attrs}>`;
      break;

    case "number":
      input = `<input type="number" id="${field.id}" value="${value ?? ""}" ${attrs}>`;
      break;

    case "static":
      input = `<div class="static-field">${field.text || field.label || ""}</div>`;
      break;

    case "date":
      input = `<input type="date" id="${field.id}" value="${value ?? ""}" ${attrs}>`;
      break;

    case "select": {
      const options = field.options.map(opt => {
        const optValue = String(opt ?? "");
        const selected = String(value ?? "") === optValue ? "selected" : "";
        const display = optValue === "" ? (field.placeholder || "— Select —") : optValue;
        return `<option value="${escapeHtml(optValue)}" ${selected}>${escapeHtml(display)}</option>`;
      }).join("");
      input = `<select id="${field.id}" ${attrs}>${options}</select>`;
      break;
    }

    case "select-state":
      input = `<select id="${field.id}" ${attrs}>${optionsHtml(STATES, value)}</select>`;
      break;

    case "select-nj-county":
      input = `<select id="${field.id}" ${attrs}>${optionsHtml(NJ_COUNTIES, value)}</select>`;
      break;

    case "select-person-role": {
      const people = listPeopleByRole(intake, field.role);
      const peopleOptions = ["— Select —", ...people.map(p => fullName(p))];
      input = `<select id="${field.id}" ${attrs}>${optionsHtml(peopleOptions, value)}</select>`;
      break;
    }

    case "seg":
      input = renderSegmentedControl(field, value);
      break;

    case "checks-inline":
      input = renderInlineChecks(field, value);
      break;

    case "multi-addons":
      input = renderMultiAddons(field, value);
      break;

    case "toggle-extra":
      input = renderToggleExtra(field, value, intake);
      break;

    case "button": {
      const buttonClasses = ["btn"];
      if (field.buttonClass) buttonClasses.push(field.buttonClass);
      input = `<button type="button" id="${field.id}" class="${buttonClasses.join(" ")}"${buildDataAttributes(field)}>${field.text}</button>`;
      break;
    }

    case "checkbox": {
      const checked = value ? "checked" : "";
      const checkboxLabel = field.checkboxLabel || field.text || field.label || "";
      const isActive = value === true || value === "true";
      const checkSymbol = isActive ? "☑" : "☐";
      input = `
        <button type="button" class="checkbox-toggle-btn ${isActive ? 'active' : ''}" id="${field.id}" aria-pressed="${isActive}" data-checkbox="true">
          <span class="checkbox-icon">${checkSymbol}</span>
          <span class="checkbox-label">${escapeHtml(checkboxLabel)}</span>
        </button>
      `;
      break;
    }

    default:
      input = `<input type="text" id="${field.id}" value="${escapeHtml(String(value ?? ""))}" ${attrs}>`;
      break;
  }

  const labelHtml = hasLabel ? `<label>${escapeHtml(displayLabel)}</label>` : "";
  return `<div class="${wrapperClasses.join(" ")}"${conditionAttrs}>${labelHtml}${input}</div>`;
}

// Field attribute builder
function getFieldAttributes(field) {
  const attrs = [];
  if (field.placeholder) attrs.push(`placeholder="${escapeHtml(field.placeholder)}"`);
  if (field.required) attrs.push("required");
  if (field.min !== undefined) attrs.push(`min="${field.min}"`);
  if (field.max !== undefined) attrs.push(`max="${field.max}"`);
  return attrs.join(" ");
}

function evaluateShowCondition(condition, intake) {
  if (!condition) return true;
  const actual = intake?.[condition.field];
  if (condition.equals !== undefined) {
    const targets = Array.isArray(condition.equals) ? condition.equals : [condition.equals];
    return targets.includes(actual);
  }
  if (condition.notEquals !== undefined) {
    const targets = Array.isArray(condition.notEquals) ? condition.notEquals : [condition.notEquals];
    return !targets.includes(actual);
  }
  if (condition.truthy) {
    return Boolean(actual);
  }
  if (condition.falsy) {
    return !actual;
  }
  return true;
}

function buildConditionAttributes(condition) {
  if (!condition) return "";
  const operator = condition.equals !== undefined ? "equals"
    : condition.notEquals !== undefined ? "notEquals"
    : condition.truthy ? "truthy"
    : condition.falsy ? "falsy" : "equals";
  let valueAttr = "";
  if (operator === "equals" || operator === "notEquals") {
    const raw = condition.equals !== undefined ? condition.equals : condition.notEquals;
    const serialized = Array.isArray(raw) ? raw.join("||") : String(raw);
    valueAttr = ` data-show-when-value="${serialized}"`;
  }
  return ` data-show-when-field="${condition.field}" data-show-when-operator="${operator}"${valueAttr}`;
}

function buildDataAttributes(field) {
  if (!field.dataAttrs) return "";
  return Object.entries(field.dataAttrs).map(([key, rawValue]) => {
    if (rawValue === undefined || rawValue === null) return "";
    return ` data-${key}="${escapeHtml(String(rawValue))}"`;
  }).join("");
}

// Segmented control renderer
function renderSegmentedControl(field, value) {
  const buttons = field.options.map(opt => 
    `<button type="button" class="seg-btn ${opt === value ? 'active' : ''}" data-value="${opt}" data-field="${field.id}">${opt}</button>`
  ).join("");
  return `<div class="seg-control" id="${field.id}">${buttons}</div>`;
}

// Inline checkboxes
function renderInlineChecks(field, value) {
  const valueArray = Array.isArray(value) ? value : [];
  const checkboxes = field.options.map(opt => {
    const checked = valueArray.includes(opt) ? "checked" : "";
    return `<label class="check-inline"><input type="checkbox" value="${opt}" ${checked}> ${opt}</label>`;
  }).join(" ");
  return `<div class="checks-inline" id="${field.id}">${checkboxes}</div>`;
}

// Multi-addon selector
function renderMultiAddons(field, value) {
  const valueArray = Array.isArray(value) ? value : [];
  const options = field.options.map(opt => {
    const checked = valueArray.includes(opt) ? "checked" : "";
    return `<label class="addon-item"><input type="checkbox" value="${opt}" ${checked}> ${opt}</label>`;
  }).join("");
  return `<div class="multi-addons" id="${field.id}">${options}</div>`;
}

function renderToggleExtra(field, value, intake) {
  const isActive = value === true || value === "true";
  const label = field.label || field.text || "Add";
  const iconSymbol = isActive ? "−" : "+";
  return `
    <div class="toggle-extra">
      <button type="button" class="toggle-extra-btn ${isActive ? 'active' : ''}" id="${field.id}" aria-expanded="${isActive}" aria-pressed="${isActive}">
        <span class="toggle-icon">${iconSymbol}</span>
        <span class="toggle-label">${escapeHtml(label)}</span>
      </button>
    </div>
  `;
}

// Checkbox group renderer
function renderChecks(item, intake) {
  const value = intake[item.id] || item.value || [];
  const valueArray = Array.isArray(value) ? value : [];
  const colClass = item.type === "checks-2col" ? "checks-2col" : "checks";
  
  const checkboxes = item.options.map(opt => {
    const checked = valueArray.includes(opt) ? "checked" : "";
    return `<label class="check-item"><input type="checkbox" value="${opt}" ${checked}> ${opt}</label>`;
  }).join("");
  
  return `<div class="col-12"><div class="${colClass}" id="${item.id}">${checkboxes}</div></div>`;
}

// Radio group renderer
function renderRadio(item, intake) {
  const value = intake[item.id] || item.value || "";
  
  const radios = item.options.map(opt => {
    const checked = opt === value ? "checked" : "";
    return `<label class="radio-item"><input type="radio" name="${item.id}" value="${opt}" ${checked}> ${opt}</label>`;
  }).join("");
  
  return `<div class="col-12"><div class="radio-group" id="${item.id}">${radios}</div></div>`;
}

// Repeat field renderer
function renderRepeat(item, intake) {
  const values = intake[item.id] || item.value || [];
  const valueArray = Array.isArray(values) ? values : [];
  
  let html = `<div class="col-12"><h4>${item.label} List</h4>`;
  html += `<div class="repeat-container" id="${item.id}">`;
  
  valueArray.forEach((val, idx) => {
    const options = item.options.map(opt => `<option ${opt === val ? 'selected' : ''}>${opt}</option>`).join("");
    html += `<div class="repeat-item">
      <select class="repeat-select" data-idx="${idx}">${options}</select>
      <button type="button" class="btn repeat-remove" data-idx="${idx}">Remove</button>
    </div>`;
  });
  
  html += `</div>`;
  html += `<button type="button" class="btn repeat-add" data-field="${item.id}">+ Add ${item.label}</button>`;
  html += `</div>`;
  
  return html;
}

// Client info block renderer
function renderClientInfoBlock(intake) {
  const includeMiddle = intake.ClientMiddleToggle === true;
  const includeSuffix = intake.ClientSuffixToggle === true;
  const middleRaw = (intake.ClientMiddleName || "").trim();
  const middle = includeMiddle
    ? (intake.ClientMiddleInitialOnly && middleRaw
        ? `${middleRaw.charAt(0).toUpperCase()}.`
        : middleRaw)
    : "";
  const suffix = includeSuffix ? (intake.ClientSuffix || "") : "";
  const fullName = [intake.ClientFirstName, middle, intake.ClientLastName, suffix].filter(Boolean).join(" ");
  const address = [
    intake.ClientStreet1,
    intake.ClientStreet2,
    [intake.ClientCity, intake.DomicileState, intake.ClientZip].filter(Boolean).join(", ")
  ].filter(Boolean).join("\n");
  
  const relationshipStatus = intake.RelationshipStatus || "Not specified";
  const hasChildren = intake.HasChildren || "No";
  
  let html = `<div class="col-12">`;
  html += `<div class="client-info-card">`;
  
  // Name section
  html += `<div class="info-section">`;
  html += `<div class="info-label">Full Name</div>`;
  html += `<div class="info-value">${fullName || '<span class="missing">Not entered</span>'}</div>`;
  html += `</div>`;
  
  // Address section
  html += `<div class="info-section">`;
  html += `<div class="info-label">Address</div>`;
  html += `<div class="info-value address-block">${address ? address.replace(/\n/g, '<br>') : '<span class="missing">Not entered</span>'}</div>`;
  html += `</div>`;
  
  // Relationship status
  html += `<div class="info-section">`;
  html += `<div class="info-label">Relationship Status</div>`;
  html += `<div class="info-value">${relationshipStatus}</div>`;
  html += `</div>`;
  
  // Children status
  html += `<div class="info-section">`;
  html += `<div class="info-label">Has Children</div>`;
  html += `<div class="info-value">${hasChildren}</div>`;
  html += `</div>`;
  
  // Edit button
  html += `<div class="info-actions">`;
  html += `<button type="button" class="btn btn-edit-testator" id="editTestatorInfo">`;
  html += `<span>✎</span> Edit Testator Information`;
  html += `</button>`;
  html += `</div>`;
  
  html += `</div>`;
  html += `</div>`;
  
  return html;
}

// Family members block renderer
function renderFamilyTree(intake) {
  const clientPerson = buildClientPerson(intake);
  const nameBank = Array.isArray(intake.NameBank)
    ? intake.NameBank.map(normalizeNameBankPerson)
    : [];

  const children = nameBank.filter(person => getPrimaryRole(person) === "Child");
  const adultCandidates = nameBank.filter(person => getPrimaryRole(person) !== "Child");
  const adultsById = new Map(adultCandidates.map(adult => [adult.id, adult]));
  const spouseCandidates = adultCandidates.filter(person => getPrimaryRole(person) === "Spouse");

  const describePartner = (id) => {
    if (!id) {
      return { id: "", name: "Unassigned", caption: "Partner", modifier: "placeholder" };
    }
    if (id === CLIENT_PARENT_ID) {
      const name = clientPerson ? (fullName(clientPerson) || "Client / Testator") : "Client / Testator";
      return { id, name, caption: "Client", modifier: "client" };
    }
    const person = adultsById.get(id);
    if (!person) {
      return { id, name: "Not in Name Bank", caption: "Unknown", modifier: "placeholder" };
    }
    const role = getPrimaryRole(person);
    const badge = (person.roles || []).find(r => !NAME_BANK_BASE_ROLES.includes(r));
    const caption = badge || role || "Partner";
    const modifier = role === "Spouse" ? "spouse" : "partner";
    return { id, name: fullName(person) || "Unnamed Person", caption, modifier };
  };

  const describeChild = (person) => {
    const name = fullName(person) || "Unnamed Child";
    const relationship = person.childRelationship || "Child";
    const supplemental = relationship !== "Biological"
      ? (person.childTreatAsBio === "Yes" ? "treated as biological" : "not treated as biological")
      : "";
    const meta = supplemental ? `${relationship} • ${supplemental}` : relationship;
    return { id: person.id, name, meta };
  };

  const bucketedChildren = new Map();
  children.forEach(child => {
    const parentA = child.childParentAId || "";
    const parentB = child.childParentBId || "";
    let key = "__no_partner__";
    if (parentA === CLIENT_PARENT_ID && parentB) {
      key = parentB;
    } else if (parentB === CLIENT_PARENT_ID && parentA) {
      key = parentA;
    } else if (parentA) {
      key = parentA;
    } else if (parentB) {
      key = parentB;
    }
    if (!bucketedChildren.has(key)) {
      bucketedChildren.set(key, []);
    }
    bucketedChildren.get(key).push(child);
  });

  let primaryPartnerId = "";
  if (spouseCandidates.length) {
    primaryPartnerId = spouseCandidates[0].id;
  } else {
    let maxChildren = -1;
    bucketedChildren.forEach((childList, key) => {
      if (key === "__no_partner__" || !key) return;
      if (childList.length > maxChildren) {
        maxChildren = childList.length;
        primaryPartnerId = key;
      }
    });
  }

  const formerPartners = new Set();
  bucketedChildren.forEach((childList, partnerId) => {
    if (partnerId && partnerId !== primaryPartnerId && partnerId !== "__no_partner__") {
      formerPartners.add(partnerId);
    }
  });
  adultCandidates
    .filter(adult => adult.roles && adult.roles.includes("Former Spouse"))
    .forEach(former => {
      if (former.id !== primaryPartnerId) formerPartners.add(former.id);
    });

  const partnerOrder = [...formerPartners];
  if (primaryPartnerId) partnerOrder.push(primaryPartnerId);
  const uniquePartnerOrder = Array.from(new Set(partnerOrder)).filter(partnerId => partnerId && partnerId !== "__no_partner__");

  const partnerStacks = uniquePartnerOrder.map(partnerId => {
    const partnerDescriptor = describePartner(partnerId);
    const childList = bucketedChildren.get(partnerId) || [];
    return { partner: partnerDescriptor, children: childList.map(describeChild) };
  });

  const unpairedChildren = bucketedChildren.get("__no_partner__") || [];

  const clientNode = describePartner(CLIENT_PARENT_ID);

  const partnerStacksHtml = partnerStacks.length
    ? partnerStacks.map(stack => `
        <div class="tree-partner-stack ${stack.partner.modifier === 'spouse' || stack.partner.id === primaryPartnerId ? 'tree-partner-stack--current' : 'tree-partner-stack--former'}">
          <div class="stack-partner">${renderTreeNode(stack.partner)}</div>
          ${stack.children.length
            ? `<div class="stack-children">
                ${stack.children.map(child => renderTreeNode({ ...child, modifier: "child" })).join("")}
              </div>`
            : `<div class="stack-children stack-children--empty">${renderTreeNode({ name: "No children", caption: "Linked", modifier: "placeholder" })}</div>`}
        </div>
      `).join("")
    : `<div class="tree-partner-placeholder">${renderTreeNode({ name: "No partners added", caption: "Create spouses or co-parents in the Name Bank", modifier: "placeholder" })}</div>`;

  const layoutHtml = `
    <div class="tree-main">
      <div class="tree-row tree-row--client">
        ${renderTreeNode(clientNode)}
      </div>
      <div class="tree-row tree-row--partners">
        ${partnerStacksHtml}
      </div>
      ${unpairedChildren.length ? `
        <div class="tree-row tree-row--unpaired">
          <div class="tree-note">Children not yet linked to a partner</div>
          <div class="tree-row tree-row--children">
            ${unpairedChildren.map(child => renderTreeNode({ ...describeChild(child), modifier: "child" })).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  `;

  const hasPartners = partnerStacks.length > 0;
  const subtitle = hasPartners
    ? "Client centered, current partner on the right, former partners to the left."
    : "Add spouses, partners, or co-parents in the Name Bank to populate branches.";

  const headerHtml = `
    <div class="family-tree-header">
      <div class="tree-title">Family Tree Overview</div>
      <div class="tree-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;

  return `<div class="col-12"><div class="family-tree">${headerHtml}${layoutHtml}</div></div>`;
}

function renderTreeNode(descriptor = {}) {
  const name = escapeHtml(descriptor.name || "Unknown");
  const caption = descriptor.caption ? escapeHtml(descriptor.caption) : "";
  const modifier = descriptor.modifier ? ` tree-node--${descriptor.modifier}` : "";
  return `
    <div class="tree-node${modifier}">
      <div class="tree-node-name">${name}</div>
      ${caption ? `<div class="tree-node-meta">${caption}</div>` : ""}
    </div>
  `;
}

function renderFamilyMembersBlock(intake) {
  const normalizedBank = Array.isArray(intake.NameBank)
    ? intake.NameBank.map(normalizeNameBankPerson)
    : [];
  const spouses = normalizedBank.filter(person => getPrimaryRole(person) === "Spouse");
  const children = normalizedBank.filter(person => getPrimaryRole(person) === "Child");
  const clientPerson = buildClientPerson(intake);
  
  let html = `<div class="col-12">`;
  
  if (spouses.length === 0 && children.length === 0) {
    html += `<div class="family-empty">`;
    html += `<p class="muted">No family members found in Name Bank. Add spouses and children in the Name Bank tab first.</p>`;
    html += `<button type="button" class="btn" id="goToNameBank">Go to Name Bank</button>`;
    html += `</div>`;
  } else {
    html += `<div class="family-members-grid">`;
    
    // Render spouse cards
    spouses.forEach((spouse, idx) => {
      html += renderFamilyMemberCard(spouse, "Spouse", idx, intake, normalizedBank, clientPerson);
    });
    
    // Render children cards
    children.forEach((child, idx) => {
      html += renderFamilyMemberCard(child, "Child", idx, intake, normalizedBank, clientPerson);
    });
    
    html += `</div>`;
  }
  
  html += `</div>`;
  return html;
}

// Individual family member card renderer
function renderFamilyMemberCard(person, role, idx, intake, nameBank = [], clientPerson = null) {
  const normalizedPerson = normalizeNameBankPerson(person);
  const personId = normalizedPerson.id;
  const memberKey = `FamilyMember_${personId}`;
  const memberData = intake[memberKey] || {};
  const clientName = clientPerson ? fullName(clientPerson) : "Client / Testator";
  const effectiveClientName = clientName || "Client / Testator";
  const displayName = fullName(normalizedPerson) || `Person ${idx + 1}`;
  const availableParents = nameBank.filter(other => other.id !== personId && getPrimaryRole(other) !== "Child");
  const defaultOtherParent = availableParents.find(p => getPrimaryRole(p) === "Spouse") || availableParents[0];
  const selectedOtherParent = memberData.parentB || (defaultOtherParent ? defaultOtherParent.id : "");
  const selectedChildType = memberData.childType || "Biological";
  const treatAsBioValue = selectedChildType === "Biological"
    ? "Yes"
    : (memberData.treatAsBio || "Yes");
  const showTreatmentField = selectedChildType !== "Biological";
  
  let html = `<div class="family-member-card" data-person-id="${personId}" data-role="${role}">`;
  
  // Header with name and role
  html += `<div class="family-member-header">`;
  html += `<div class="member-name">${escapeHtml(displayName)}</div>`;
  html += `<div class="member-role-badge ${role.toLowerCase()}">${role}</div>`;
  html += `</div>`;
  
  // Child type selection (only for children)
  if (role === "Child") {
    html += `<div class="member-field">`;
    html += `<label>Parent A</label>`;
    html += `<div class="member-parent-display">${escapeHtml(effectiveClientName)}</div>`;
    html += `</div>`;

    html += `<div class="member-field">`;
    html += `<label>Parent B</label>`;
    html += `<select class="member-input" data-field="parentB" data-person="${personId}">`;
    html += `<option value="">— Select other parent —</option>`;
    availableParents.forEach(parent => {
      const parentName = fullName(parent) || "Unnamed Person";
      const selected = parent.id === selectedOtherParent ? "selected" : "";
      html += `<option value="${escapeHtml(parent.id)}" ${selected}>${escapeHtml(parentName)}</option>`;
    });
    html += `</select>`;
    html += `</div>`;

    html += `<div class="member-field">`;
    html += `<label>Relationship Type</label>`;
    html += `<div class="seg-control">`;
    CHILD_RELATIONSHIP_TYPES.forEach(type => {
      html += `<button type="button" class="seg-btn ${type === selectedChildType ? 'active' : ''}" 
               data-field="childType" data-value="${type}" data-person="${personId}">${type}</button>`;
    });
    html += `</div>`;
    html += `</div>`;

    html += `<div class="member-field child-treatment-field ${showTreatmentField ? "" : "hidden-field"}" data-person="${personId}">`;
    html += `<label>Treat the same as biological child?</label>`;
    html += `<div class="seg-control">`;
    ["Yes", "No"].forEach(option => {
      const active = option === treatAsBioValue ? "active" : "";
      html += `<button type="button" class="seg-btn ${active}" data-field="treatAsBio" data-value="${option}" data-person="${personId}">${option}</button>`;
    });
    html += `</div>`;
    html += `</div>`;
  }
  
  // Date of Birth
  html += `<div class="member-field">`;
  html += `<label>Date of Birth</label>`;
  html += `<input type="date" class="member-input" data-field="dob" data-person="${personId}" 
           value="${memberData.dob || ''}" placeholder="YYYY-MM-DD">`;
  html += `</div>`;
  
  // Address section
  html += `<div class="member-field">`;
  html += `<label>Address</label>`;
  html += `<div class="address-helper">`;
  html += `<button type="button" class="btn-helper member-same-address" data-person="${personId}">Same as Testator</button>`;
  html += `</div>`;
  html += `</div>`;
  
  // Address fields
  html += `<div class="member-address">`;
  html += `<div class="address-row">`;
  html += `<input type="text" class="member-input" data-field="street1" data-person="${personId}" 
           value="${memberData.street1 || ''}" placeholder="Street Address">`;
  html += `</div>`;
  html += `<div class="address-row">`;
  html += `<input type="text" class="member-input" data-field="street2" data-person="${personId}" 
           value="${memberData.street2 || ''}" placeholder="Street Address 2 (optional)">`;
  html += `</div>`;
  html += `<div class="address-row-split">`;
  html += `<input type="text" class="member-input" data-field="city" data-person="${personId}" 
           value="${memberData.city || ''}" placeholder="City">`;
  html += `<input type="text" class="member-input" data-field="zip" data-person="${personId}" 
           value="${memberData.zip || ''}" placeholder="ZIP">`;
  html += `</div>`;
  html += `<div class="address-row-split">`;
  html += `<select class="member-input" data-field="county" data-person="${personId}">`;
  html += `<option value="">Select County...</option>`;
  html += optionsHtml(NJ_COUNTIES, memberData.county || "");
  html += `</select>`;
  html += `<select class="member-input" data-field="state" data-person="${personId}">`;
  html += `<option value="">Select State...</option>`;
  html += optionsHtml(STATES, memberData.state || "New Jersey");
  html += `</select>`;
  html += `</div>`;
  html += `</div>`;
  
  html += `</div>`;
  return html;
}

// Gifts manager renderer
function renderGiftsManager(intake) {
  const specificGifts = intake.SpecificGifts || [];
  
  let html = `<div class="col-12">`;
  
  // Buttons for gifts
  html += `<div class="gifts-controls">`;
  html += `<button type="button" class="btn btn-primary" id="addGiftBtn">+ Add Gift</button>`;
  html += `</div>`;
  
  // Gift cards container
  html += `<div class="gifts-list" id="giftsList">`;
  if (specificGifts.length === 0) {
    html += `<div class="gifts-empty">No specific gifts yet. Use "+ Add Gift" to add a bequest.</div>`;
  } else {
    specificGifts.forEach((gift, idx) => {
      html += renderGiftCard(gift, idx, intake);
    });
  }
  html += `</div>`;
  
  html += `</div>`;
  return html;
}

function renderGiftCard(gift, idx, intake) {
  const giftId = gift.id || `gift-${idx}`;
  const giftType = gift.type || 'item';
  const benRef = gift.benRef || '';
  const benCustom = gift.benCustom || '';
  const predecease = gift.predecease || 'per_stirpes';
  const alternates = gift.alternates || '';
  const notes = gift.notes || '';
  
  const nameBank = intake.NameBank || [];
  const peopleOptions = nameBank.map(p => ({
    value: p.id,
    label: fullName(p)
  }));
  
  const giftTypeOptions = [
    { value: 'cash', label: 'Cash' },
    { value: 'item', label: 'Specific Item' },
    { value: 'percent', label: 'Percentage of Estate' },
    { value: 'real_property', label: 'Real Property' },
    { value: 'digital', label: 'Digital Asset' },
    { value: 'other', label: 'Other' }
  ];
  
  const predeceaseOptions = [
    { value: 'per_stirpes', label: 'Per stirpes' },
    { value: 'per_capita', label: 'Per capita' },
    { value: 'alternates', label: 'To alternates' },
    { value: 'residuary', label: 'Lapse to residuary' }
  ];
  
  let html = `<div class="gift-card" data-gift-id="${giftId}" data-gift-index="${idx}">`;
  
  // Card header with controls
  html += `<div class="gift-card-header">`;
  html += `<span class="gift-type-badge">${giftTypeOptions.find(o => o.value === giftType)?.label || 'Gift'}</span>`;
  html += `<div class="gift-card-controls">`;
  html += `<button type="button" class="btn-icon gift-up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>`;
  html += `<button type="button" class="btn-icon gift-down" title="Move down">↓</button>`;
  html += `<button type="button" class="btn-icon gift-duplicate" title="Duplicate">⧉</button>`;
  html += `<button type="button" class="btn-icon gift-remove" title="Remove">×</button>`;
  html += `</div>`;
  html += `</div>`;
  
  // Gift type and beneficiary
  html += `<div class="gift-row">`;
  html += `<div class="form-field col-4">`;
  html += `<label>Gift Type</label>`;
  html += `<select class="gift-type">`;
  giftTypeOptions.forEach(opt => {
    html += `<option value="${opt.value}" ${opt.value === giftType ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`;
  });
  html += `</select>`;
  html += `</div>`;
  
  html += `<div class="form-field col-4">`;
  html += `<label>Beneficiary</label>`;
  html += `<select class="gift-beneficiary">`;
  html += `<option value="">— Select from Name Bank —</option>`;
  peopleOptions.forEach(opt => {
    html += `<option value="${opt.value}" ${opt.value === benRef ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`;
  });
  html += `</select>`;
  html += `</div>`;
  
  html += `<div class="form-field col-4">`;
  html += `<label>Beneficiary (custom, optional)</label>`;
  html += `<input type="text" class="gift-beneficiary-custom" value="${escapeHtml(benCustom)}" placeholder="e.g. Rowan University Foundation">`;
  html += `</div>`;
  html += `</div>`;
  
  // Type-specific fields
  html += `<div class="gift-details">`;
  
  // Cash
  html += `<div class="gift-details-cash" style="display: ${giftType === 'cash' ? 'block' : 'none'}">`;
  html += `<div class="form-field">`;
  html += `<label>Amount (USD)</label>`;
  html += `<input type="text" class="gift-amount" value="${escapeHtml(gift.amount || '')}" placeholder="$10,000">`;
  html += `</div>`;
  html += `</div>`;
  
  // Item
  html += `<div class="gift-details-item" style="display: ${giftType === 'item' ? 'block' : 'none'}">`;
  html += `<div class="form-field">`;
  html += `<label>Describe the item</label>`;
  html += `<textarea class="gift-item-what" rows="2" placeholder="e.g. 1965 Gibson SG electric guitar">${escapeHtml(gift.what || '')}</textarea>`;
  html += `</div>`;
  html += `</div>`;
  
  // Percent
  html += `<div class="gift-details-percent" style="display: ${giftType === 'percent' ? 'block' : 'none'}">`;
  html += `<div class="form-field">`;
  html += `<label>Percentage (%)</label>`;
  html += `<input type="number" class="gift-percent" min="0" max="100" step="0.01" value="${gift.percent || ''}" placeholder="e.g. 25">`;
  html += `</div>`;
  html += `</div>`;
  
  // Real Property
  html += `<div class="gift-details-real_property" style="display: ${giftType === 'real_property' ? 'block' : 'none'}">`;
  html += `<div class="form-field">`;
  html += `<label>Property address/description</label>`;
  html += `<textarea class="gift-rp-address" rows="2" placeholder="Street, City, State zip; legal description if needed">${escapeHtml(gift.rpAddr || '')}</textarea>`;
  html += `</div>`;
  html += `</div>`;
  
  // Digital
  html += `<div class="gift-details-digital" style="display: ${giftType === 'digital' ? 'block' : 'none'}">`;
  html += `<div class="gift-row">`;
  html += `<div class="form-field col-6">`;
  html += `<label>Platform</label>`;
  html += `<input type="text" class="gift-dig-platform" value="${escapeHtml(gift.digPlatform || '')}" placeholder="e.g. Coinbase, Apple, Google">`;
  html += `</div>`;
  html += `<div class="form-field col-6">`;
  html += `<label>Identifier</label>`;
  html += `<input type="text" class="gift-dig-id" value="${escapeHtml(gift.digId || '')}" placeholder="username, wallet, etc.">`;
  html += `</div>`;
  html += `</div>`;
  html += `</div>`;
  
  // Other
  html += `<div class="gift-details-other" style="display: ${giftType === 'other' ? 'block' : 'none'}">`;
  html += `<div class="form-field">`;
  html += `<label>Gift text</label>`;
  html += `<textarea class="gift-other-text" rows="2" placeholder="Free-form text for unusual gifts">${escapeHtml(gift.otherText || '')}</textarea>`;
  html += `</div>`;
  html += `</div>`;
  
  html += `</div>`; // end gift-details
  
  // Predecease handling
  html += `<div class="gift-row">`;
  html += `<div class="form-field col-4">`;
  html += `<label>If beneficiary predeceases</label>`;
  html += `<select class="gift-predecease">`;
  predeceaseOptions.forEach(opt => {
    html += `<option value="${opt.value}" ${opt.value === predecease ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`;
  });
  html += `</select>`;
  html += `</div>`;
  
  html += `<div class="form-field col-4">`;
  html += `<label>Alternates (comma-separated names)</label>`;
  html += `<input type="text" class="gift-alternates" value="${escapeHtml(alternates)}" placeholder="e.g. Lisa Simpson, Maggie Simpson">`;
  html += `</div>`;
  
  html += `<div class="form-field col-4">`;
  html += `<label>Notes (optional)</label>`;
  html += `<input type="text" class="gift-notes" value="${escapeHtml(notes)}" placeholder="Any additional conditions or info">`;
  html += `</div>`;
  html += `</div>`;
  
  html += `</div>`; // end gift-card
  
  return html;
}

// Name bank renderer
function renderNameBank(intake) {
  let nameBank = Array.isArray(intake.NameBank) ? [...intake.NameBank] : [];
  nameBank = ensureRequiredNameBankEntries(intake, nameBank);

  const cards = [];

  const clientCard = renderClientCard(intake);
  if (clientCard) {
    cards.push(clientCard);
  }

  nameBank.forEach((person, idx) => {
    if (person.entityType === 'charity') {
      cards.push(renderCharityCard(person, idx, nameBank, intake));
    } else if (person.entityType === 'corporate') {
      cards.push(renderCorporateCard(person, idx, nameBank, intake));
    } else {
      cards.push(renderPersonCard(person, idx, nameBank, intake));
    }
  });

  let html = `<div class="col-12">`;
  html += `<div class="namebank-controls">`;
  html += `<div class="namebank-controls-group">`;
  NAME_BANK_BASE_ROLES.forEach(role => {
    html += `<button type="button" class="btn namebank-add" data-role="${role}">+ ${role}</button>`;
  });
  html += `</div>`;
  html += `<div class="namebank-controls-note">Use badges on each card to assign fiduciary roles like Executor or Trustee.</div>`;
  html += `</div>`;

  html += `<div class="namebank-grid" id="NameBank">`;
  if (cards.length === 0) {
    html += `<div class="namebank-empty">Add people using the buttons above to assign roles for your will.</div>`;
  } else {
    html += cards.join("");
  }
  html += `</div>`;
  html += `</div>`;

  return html;
}

function normalizeClientDobParts(rawDob) {
  if (!rawDob) {
    return { month: "", day: "", year: "" };
  }
  const parts = String(rawDob).split("-");
  if (parts.length !== 3) {
    return { month: "", day: "", year: "" };
  }
  const [year, month, day] = parts;
  const monthNumber = parseInt(month, 10);
  const dayNumber = parseInt(day, 10);
  return {
    month: Number.isFinite(monthNumber) && monthNumber >= 1 && monthNumber < MONTHS.length ? MONTHS[monthNumber] : "",
    day: Number.isFinite(dayNumber) ? String(dayNumber) : "",
    year: year || ""
  };
}

function buildClientPerson(intake) {
  if (!intake) return null;
  const middleEnabled = intake.ClientMiddleToggle === true;
  const suffixEnabled = intake.ClientSuffixToggle === true;
  const { month, day, year } = normalizeClientDobParts(intake.ClientDOB);
  return {
    first: intake.ClientFirstName || "",
    middle: middleEnabled ? intake.ClientMiddleName || "" : "",
    middleEnabled,
    middleInitialOnly: intake.ClientMiddleInitialOnly === true,
    last: intake.ClientLastName || "",
    suffix: suffixEnabled ? intake.ClientSuffix || "" : "",
    suffixEnabled,
    addressStreet1: intake.ClientStreet1 || "",
    addressStreet2: intake.ClientStreet2 || "",
    addressCity: intake.ClientCity || "",
    addressCounty: intake.DomicileCounty || "",
    addressState: intake.DomicileState || "",
    addressZip: intake.ClientZip || "",
    dobMonth: month,
    dobDay: day,
    dobYear: year,
    roles: ["Testator"],
  };
}

function renderClientCard(intake) {
  const clientPerson = buildClientPerson(intake);
  if (!clientPerson) return "";
  const summaryHtml = buildPersonSummary(clientPerson);
  return `<div class="person-card person-card--summary person-card--client" data-role="Client">
    <div class="person-card-head">
      <div class="person-card-title">Client / Testator</div>
      <div class="person-card-actions">
        <button type="button" class="btn-small btn-primary client-edit">Edit in Testator</button>
      </div>
    </div>
    <div class="person-card-body person-card-summary">
      ${summaryHtml}
    </div>
  </div>`;
}

function countRole(nameBank, role) {
  return nameBank.filter(person => getPrimaryRole(person) === role).length;
}

function createNameBankPerson(role = "", overrides = {}) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const requestedRole = NAME_BANK_BASE_ROLES.includes(role) ? role : "Other";
  
  // Create charity entity if role is "Charity"
  if (requestedRole === "Charity") {
    const charityBase = {
      id: `${stamp}-${rand}`,
      entityType: "charity",
      primaryRole: "Charity",
      roles: ["Charity"],
      viewMode: "edit",
      charityName: "",
      charityPurpose: "",
      charityEIN: "",
      charityStreet1: "",
      charityStreet2: "",
      charityCity: "",
      charityState: "",
      charityZip: "",
      charityEmail: "",
      charityPhone: "",
    };
    return { ...charityBase, ...overrides };
  }
  
  // Create corporate fiduciary entity if role is "Corporate Fiduciary"
  if (requestedRole === "Corporate Fiduciary") {
    const corporateBase = {
      id: `${stamp}-${rand}`,
      entityType: "corporate",
      primaryRole: "Corporate Fiduciary",
      roles: ["Corporate Fiduciary"],
      viewMode: "edit",
      charityName: "", // Reuse charity fields for corporate name
      charityPurpose: "", // Not needed for corporate but kept for compatibility
      charityEIN: "",
      charityStreet1: "",
      charityStreet2: "",
      charityCity: "",
      charityState: "",
      charityZip: "",
      charityEmail: "",
      charityPhone: "",
    };
    return { ...corporateBase, ...overrides };
  }
  
  // Create person entity for all other roles
  const base = {
    id: `${stamp}-${rand}`,
    first: "",
    middle: "",
    last: "",
    suffix: "",
    primaryRole: requestedRole,
    roles: [requestedRole],
    viewMode: "edit",
    middleEnabled: false,
    middleInitialOnly: false,
    suffixEnabled: false,
    addressEnabled: false,
    addressStreet1: "",
    addressStreet2: "",
    addressCity: "",
    addressCounty: "",
    addressState: "",
    addressZip: "",
    dobMonth: "",
    dobDay: "",
    dobYear: "",
    childRelationship: "Biological",
    childTreatAsBio: "Yes",
    childParentAId: CLIENT_PARENT_ID,
    childParentBId: "",
  };
  return normalizeNameBankPerson({ ...base, ...overrides });
}

function addNameBankPerson(role = "", overrides = {}) {
  const intake = readIntake();
  const nameBank = Array.isArray(intake.NameBank) ? [...intake.NameBank] : [];
  const newPerson = createNameBankPerson(role, overrides);
  nameBank.push(newPerson);
  const nextIntake = { ...intake, NameBank: nameBank };
  writeIntake({ NameBank: nameBank });
  syncChildrenCountWithNameBank(nextIntake, nameBank);
  debouncedRender();
  renderTab(currentArticle);
  return newPerson;
}

function syncChildrenCountWithNameBank(intakeSnapshot, nameBank) {
  const snapshot = intakeSnapshot ? { ...intakeSnapshot } : readIntake();
  const normalizedBank = Array.isArray(nameBank)
    ? nameBank.map(normalizeNameBankPerson)
    : Array.isArray(snapshot.NameBank)
      ? snapshot.NameBank.map(normalizeNameBankPerson)
      : [];
  const childCount = normalizedBank.filter(person => getPrimaryRole(person) === "Child").length;
  const currentCountRaw = parseInt(snapshot.ChildrenCount, 10);
  const currentCount = Number.isFinite(currentCountRaw) ? currentCountRaw : 0;
  const desiredHasChildren = childCount > 0 ? "Yes" : "No";
  const currentHasChildren = snapshot.HasChildren || (currentCount > 0 ? "Yes" : "No");
  const updates = {};
  if (childCount !== currentCount) {
    updates.ChildrenCount = childCount;
  }
  if (currentHasChildren !== desiredHasChildren) {
    updates.HasChildren = desiredHasChildren;
  }
  if (Object.keys(updates).length > 0) {
    writeIntake(updates);
  }
  const mergedIntake = { ...snapshot, ...updates, NameBank: normalizedBank };
  App.setState({ intake: mergedIntake });
}

function addCoParentForChild(childIdx) {
  const intake = readIntake();
  const existingBank = Array.isArray(intake.NameBank) ? [...intake.NameBank] : [];
  if (!existingBank[childIdx]) return;

  const child = normalizeNameBankPerson(existingBank[childIdx]);
  const newParent = createNameBankPerson("Other", {
    primaryRole: "Other",
    roles: ["Other", "Former Spouse"],
    viewMode: "edit"
  });

  let parentAId = child.childParentAId || "";
  let parentBId = child.childParentBId || "";

  if (!parentAId) {
    parentAId = newParent.id;
  } else if (!parentBId) {
    parentBId = newParent.id;
  }

  const updatedChild = normalizeNameBankPerson({
    ...child,
    childParentAId: parentAId,
    childParentBId: parentBId
  });

  const updatedBank = existingBank.map((entry, idx) => idx === childIdx ? updatedChild : entry);
  updatedBank.push(newParent);

  writeIntake({ NameBank: updatedBank });
  syncChildrenCountWithNameBank({ ...intake, NameBank: updatedBank }, updatedBank);
  debouncedRender();
  renderTab(currentArticle);
}

function ensureRequiredNameBankEntries(intake, currentBank) {
  let mutated = false;
  const nameBank = Array.isArray(currentBank)
    ? currentBank.map(person => {
        const normalized = normalizeNameBankPerson(person);
        if (normalized !== person && !mutated) {
          const keys = Object.keys(normalized);
          const diff = keys.some(key => normalized[key] !== person[key]);
          if (diff) mutated = true;
        }
        return normalized;
      })
    : [];

  const guaranteeRole = (role, count) => {
    const existing = countRole(nameBank, role);
    if (existing >= count) return;
    for (let i = existing; i < count; i += 1) {
      nameBank.push(createNameBankPerson(role));
      mutated = true;
    }
  };

  const relationship = (intake?.RelationshipStatus || "").toLowerCase();
  if (relationship === "married") {
    guaranteeRole("Spouse", 1);
  }

  const hasChildren = (intake?.HasChildren || "").toLowerCase();
  if (hasChildren === "yes") {
    const declaredRaw = parseInt(intake?.ChildrenCount, 10);
    const requiredChildren = Number.isFinite(declaredRaw) ? Math.max(declaredRaw, 1) : 1;
    guaranteeRole("Child", requiredChildren);
  }

  const priority = (person) => {
    const primary = getPrimaryRole(person);
    if (primary === "Spouse") return 0;
    if (primary === "Child") return 1;
    return 2;
  };
  nameBank.sort((a, b) => priority(a) - priority(b));

  if (mutated) {
    const nextIntake = { ...App.state.intake, NameBank: nameBank };
    writeIntake({ NameBank: nameBank });
    syncChildrenCountWithNameBank(nextIntake, nameBank);
  }

  return nameBank;
}

function formatDobSummary(person) {
  const month = person.dobMonth || "";
  const day = person.dobDay || "";
  const year = person.dobYear || "";
  if (!month && !day && !year) return "";
  let dateText = "";
  if (month) {
    dateText = day ? `${month} ${day}` : month;
  } else if (day) {
    dateText = `Day ${day}`;
  }
  if (year) {
    dateText = dateText ? `${dateText}, ${year}` : year;
  }
  return dateText.trim();
}

function buildPersonSummary(person) {
  const lines = [];
  const name = fullName(person);
  if (name) {
    lines.push(`<div class="summary-line summary-name">${escapeHtml(name)}</div>`);
  }

  const hasAddressData = Boolean(
    person.addressStreet1 ||
    person.addressStreet2 ||
    person.addressCity ||
    person.addressCounty ||
    person.addressState ||
    person.addressZip
  );

  if (hasAddressData || person.addressEnabled) {
    const streetParts = [person.addressStreet1, person.addressStreet2].filter(Boolean);
    if (streetParts.length) {
      lines.push(`<div class="summary-line">${escapeHtml(streetParts.join(", "))}</div>`);
    }
    const localeParts = [];
    if (person.addressCity) localeParts.push(person.addressCity);
    const stateZip = [person.addressState, person.addressZip].filter(Boolean).join(" ");
    if (stateZip) localeParts.push(stateZip);
    let localeLine = localeParts.join(", ");
    if (localeLine && person.addressCounty) {
      localeLine += ` (${person.addressCounty})`;
    } else if (!localeLine && person.addressCounty) {
      localeLine = `${person.addressCounty} County`;
    }
    if (localeLine) {
      lines.push(`<div class="summary-line">${escapeHtml(localeLine)}</div>`);
    }
  }

  const dob = formatDobSummary(person);
  if (dob) {
    lines.push(`<div class="summary-line"><span class="summary-label">DoB:</span><span>${escapeHtml(dob)}</span></div>`);
  }

  const primaryRole = getPrimaryRole(person);
  const badgeRoles = Array.isArray(person.roles)
    ? person.roles.filter(role => role && role !== primaryRole)
    : [];
  if (primaryRole || badgeRoles.length) {
    let roleSummary = primaryRole || "";
    if (badgeRoles.length) {
      roleSummary = roleSummary
        ? `${roleSummary} — ${badgeRoles.join(", ")}`
        : badgeRoles.join(", ");
    }
    lines.push(`<div class="summary-line"><span class="summary-label">Roles:</span><span>${escapeHtml(roleSummary)}</span></div>`);
  }

  if (primaryRole === "Child") {
    if (person.childRelationship) {
      lines.push(`<div class="summary-line"><span class="summary-label">Relationship:</span><span>${escapeHtml(person.childRelationship)}</span></div>`);
    }

    const intake = readIntake();
    const client = buildClientPerson(intake);
    const nameBank = Array.isArray(intake.NameBank) ? intake.NameBank.map(normalizeNameBankPerson) : [];
    const bankById = new Map(nameBank.map(entry => [entry.id, entry]));
    const resolveParentName = (parentId) => {
      if (!parentId) return "";
      if (parentId === CLIENT_PARENT_ID) {
        return fullName(client) || "Client / Testator";
      }
      const match = bankById.get(parentId);
      if (!match) {
        return "(Parent not in Name Bank)";
      }
      return fullName(match) || "Unnamed";
    };

    const parentADisplay = resolveParentName(person.childParentAId) || "Unassigned";
    const parentBDisplay = resolveParentName(person.childParentBId) || "Unassigned";

    lines.push(`<div class="summary-line"><span class="summary-label">Parent A:</span><span>${escapeHtml(parentADisplay)}</span></div>`);
    lines.push(`<div class="summary-line"><span class="summary-label">Parent B:</span><span>${escapeHtml(parentBDisplay)}</span></div>`);

    if (person.childRelationship && person.childRelationship !== "Biological") {
      const treatText = person.childTreatAsBio === "No" ? "No" : "Yes";
      lines.push(`<div class="summary-line"><span class="summary-label">Treat as biological:</span><span>${escapeHtml(treatText)}</span></div>`);
    }
  }

  if (!lines.length) {
    lines.push(`<div class="summary-line summary-empty">No details captured yet.</div>`);
  }

  return lines.join("");
}

// Person card renderer
function renderPersonCard(person, idx, allPeople = [], intake = null) {
  const personData = normalizeNameBankPerson(person);
  const roles = personData.roles || [];
  const primaryRole = getPrimaryRole(personData);
  const displayName = fullName(personData) || `Person ${idx + 1}`;
  const viewMode = personData.viewMode === "summary" ? "summary" : "edit";
  const cardClasses = ["person-card", `person-card--${viewMode}`];
  const actionButtons = viewMode === "summary"
    ? [
        `<button type="button" class="btn-small person-edit" data-idx="${idx}">Edit card</button>`,
        `<button type="button" class="btn-small btn-remove remove-person" data-idx="${idx}">Remove</button>`
      ]
    : [
        `<button type="button" class="btn-small btn-primary person-save" data-idx="${idx}">Save card</button>`,
        `<button type="button" class="btn-small btn-remove remove-person" data-idx="${idx}">Remove</button>`
      ];
  const actionsHtml = actionButtons.join("");

  if (viewMode === "summary") {
    const summaryHtml = buildPersonSummary(personData);
    return `<div class="${cardClasses.join(" ")}" data-idx="${idx}" data-mode="${viewMode}">
      <div class="person-card-head">
        <div class="person-card-title">${escapeHtml(displayName)}</div>
        <div class="person-card-actions">${actionsHtml}</div>
      </div>
      <div class="person-card-body person-card-summary">
        ${summaryHtml}
      </div>
    </div>`;
  }

  const middleEnabled = personData.middleEnabled === undefined ? Boolean(personData.middle) : personData.middleEnabled === true;
  const suffixEnabled = personData.suffixEnabled === undefined ? Boolean(personData.suffix) : personData.suffixEnabled === true;
  const hasAddressData = Boolean(
    personData.addressStreet1 ||
    personData.addressStreet2 ||
    personData.addressCity ||
    personData.addressCounty ||
    personData.addressState ||
    personData.addressZip
  );
  const addressEnabled = personData.addressEnabled === undefined ? hasAddressData : personData.addressEnabled === true;
  const middleInitialOnly = personData.middleInitialOnly === true;
  const middleValue = personData.middle || "";
  const suffixValue = personData.suffix || "";
  const addressStreet1 = personData.addressStreet1 || "";
  const addressStreet2 = personData.addressStreet2 || "";
  const addressCity = personData.addressCity || "";
  const addressCounty = personData.addressCounty || "";
  const addressState = personData.addressState || "";
  const addressZip = personData.addressZip || "";
  const dobMonth = personData.dobMonth || "";
  const dobDay = personData.dobDay || "";
  const dobYear = personData.dobYear || "";
  const maxDay = getDaysInMonth(dobMonth, dobYear);

  const middleToggle = `
    <button type="button" class="toggle-extra-btn person-toggle-btn ${middleEnabled ? 'active' : ''}" data-idx="${idx}" data-field="middle">
      <span class="toggle-icon">${middleEnabled ? '−' : '+'}</span>
      <span class="toggle-label">Middle</span>
    </button>
  `;

  const suffixToggle = `
    <button type="button" class="toggle-extra-btn person-toggle-btn ${suffixEnabled ? 'active' : ''}" data-idx="${idx}" data-field="suffix">
      <span class="toggle-icon">${suffixEnabled ? '−' : '+'}</span>
      <span class="toggle-label">Suffix</span>
    </button>
  `;

  const addressToggle = `
    <button type="button" class="toggle-extra-btn person-toggle-btn ${addressEnabled ? 'active' : ''}" data-idx="${idx}" data-field="address">
      <span class="toggle-icon">${addressEnabled ? '−' : '+'}</span>
      <span class="toggle-label">Address details</span>
    </button>
  `;

  const suffixOptions = SUFFIX_OPTIONS.map(opt => {
    const label = opt || "None";
    const selected = opt === suffixValue ? " selected" : "";
    return `<option value="${escapeHtml(opt)}"${selected}>${escapeHtml(label)}</option>`;
  }).join("");

  const countyOptions = [`<option value="">County</option>`, ...NJ_COUNTIES.map(county => {
    const selected = county === addressCounty ? " selected" : "";
    return `<option value="${escapeHtml(county)}"${selected}>${escapeHtml(county)}</option>`;
  })].join("");

  const stateOptions = [`<option value="">State</option>`, ...STATES.map(state => {
    const selected = state === addressState ? " selected" : "";
    return `<option value="${escapeHtml(state)}"${selected}>${escapeHtml(state)}</option>`;
  })].join("");

  const roleChecks = SPECIAL_ROLE_BADGES.map(role => {
    const checked = roles.includes(role) ? "checked" : "";
    return `<label class="role-chip"><input type="checkbox" value="${role}" data-idx="${idx}" ${checked}><span>${role}</span></label>`;
  }).join("");
  const primaryRoleOptions = NAME_BANK_BASE_ROLES.map(role => {
    const selected = role === primaryRole ? " selected" : "";
    return `<option value="${role}"${selected}>${role}</option>`;
  }).join("");

  const normalizedPeople = Array.isArray(allPeople) ? allPeople.map(normalizeNameBankPerson) : [];
  const clientPerson = buildClientPerson(intake || readIntake());
  const childRelationship = personData.childRelationship || "Biological";
  const childTreatAsBio = personData.childTreatAsBio || "Yes";
  const childParentAId = personData.childParentAId || "";
  const childParentBId = personData.childParentBId || "";
  const eligibleParents = normalizedPeople
    .map((p, personIdx) => ({ person: p, idx: personIdx }))
    .filter(entry => entry.idx !== idx && getPrimaryRole(entry.person) !== "Child");
  const parentOptions = [];
  if (clientPerson) {
    const clientName = fullName(clientPerson) || "Client / Testator";
    parentOptions.push({ id: CLIENT_PARENT_ID, label: `${clientName} (Client)` });
  }
  eligibleParents.forEach(entry => {
    const label = fullName(entry.person) || `Person ${entry.idx + 1}`;
    parentOptions.push({ id: entry.person.id, label });
  });

  const buildParentSelect = (currentValue, parentKey, placeholder) => {
    if (parentOptions.length === 0) {
      return `<div class="child-parent-empty">No eligible parents yet. Add a spouse, partner, or co-parent to link children.</div>`;
    }
    const optionsHtmlList = parentOptions.map(opt => {
      const selected = opt.id === currentValue ? " selected" : "";
      return `<option value="${escapeHtml(opt.id)}"${selected}>${escapeHtml(opt.label)}</option>`;
    }).join("");
    const hasSelected = currentValue && parentOptions.some(opt => opt.id === currentValue);
    const missingOption = !hasSelected && currentValue
      ? `<option value="${escapeHtml(currentValue)}" selected>(Parent not in Name Bank)</option>`
      : "";
    return `<select class="person-child-parent" data-idx="${idx}" data-parent="${parentKey}">
      <option value="">— Select ${placeholder} —</option>
      ${optionsHtmlList}${missingOption}
    </select>`;
  };

  const parentFieldsHtml = parentOptions.length > 0
    ? `<div class="child-parent-group">
        <div class="child-parent-field">
          <span class="child-parent-label">Parent A</span>
          ${buildParentSelect(childParentAId, "A", "Parent A")}
        </div>
        <div class="child-parent-field">
          <span class="child-parent-label">Parent B</span>
          ${buildParentSelect(childParentBId, "B", "Parent B")}
        </div>
      </div>`
    : `<div class="child-parent-empty">Add another parent using the buttons above or create a co-parent below to assign shared children.</div>`;

  const stepChildNote = childRelationship === "Step-child"
    ? `<div class="relationship-note">For step-children, select the appropriate parent(s) instead of the testator.</div>`
    : "";

  const childRelationshipButtons = CHILD_RELATIONSHIP_TYPES.map(type => {
    const active = type === childRelationship ? "active" : "";
    return `<button type="button" class="seg-btn child-relationship-btn ${active}" data-idx="${idx}" data-value="${type}">${type}</button>`;
  }).join("");

  const childTreatButtons = ["Yes", "No"].map(option => {
    const active = option === childTreatAsBio ? "active" : "";
    return `<button type="button" class="seg-btn child-treatment-btn ${active}" data-idx="${idx}" data-value="${option}">${option}</button>`;
  }).join("");

  const childDetailsHtml = primaryRole === "Child" ? `
    <div class="person-child-section">
      <div class="person-child-field">
        <label>Parents</label>
        ${parentFieldsHtml}
        <div class="child-parent-actions">
          <button type="button" class="btn-small add-co-parent" data-idx="${idx}">+ Add Co-Parent / Former Spouse</button>
        </div>
        ${stepChildNote}
      </div>
      <div class="person-child-field">
        <label>Relationship type</label>
        <div class="seg-control child-relationship-group">
          ${childRelationshipButtons}
        </div>
      </div>
      <div class="person-child-field child-treatment-group ${childRelationship === "Biological" ? "hidden-field" : ""}">
        <label>Treat the same as biological?</label>
        <div class="seg-control child-treatment-options">
          ${childTreatButtons}
        </div>
      </div>
    </div>
  ` : "";

  const middleFieldClasses = ["col-6 person-field"];
  if (!middleEnabled) middleFieldClasses.push("hidden-field");
  const suffixFieldClasses = ["col-6 person-field"];
  if (!suffixEnabled) suffixFieldClasses.push("hidden-field");
  const addressSectionClass = addressEnabled ? "" : "hidden-field";

  return `<div class="${cardClasses.join(" ")}" data-idx="${idx}" data-mode="${viewMode}">
    <div class="person-card-head">
      <div class="person-card-title">${escapeHtml(displayName)}</div>
      <div class="person-card-actions">${actionsHtml}</div>
    </div>
    <div class="person-card-body">
      <div class="row person-card-row">
        <div class="col-12 person-field">
          <label>First name</label>
          <input type="text" class="person-input" data-field="first" data-idx="${idx}" value="${escapeHtml(personData.first || "")}" placeholder="First name">
        </div>
      </div>

      <div class="row person-card-row person-toggle-row">
        <div class="col-12 person-toggle">
          <label>Middle name</label>
          <div class="toggle-wrapper">${middleToggle}</div>
        </div>
      </div>

      <div class="row person-card-row person-name-extras ${middleEnabled ? "" : "hidden-field"}" data-person-section="middle" data-idx="${idx}">
        <div class="col-12 person-field">
          <input type="text" class="person-input" data-field="middle" data-idx="${idx}" value="${escapeHtml(middleValue)}" placeholder="Middle name">
          <label class="inline-checkbox"><input type="checkbox" class="person-checkbox" data-field="middleInitialOnly" data-idx="${idx}" ${middleInitialOnly ? "checked" : ""}>Initial only</label>
        </div>
      </div>

      <div class="row person-card-row">
        <div class="col-12 person-field">
          <label>Last name</label>
          <div class="person-last-wrapper">
            <input type="text" class="person-input" data-field="last" data-idx="${idx}" value="${escapeHtml(personData.last || "")}" placeholder="Last name">
            <button type="button" class="btn-helper same-as-testator" data-idx="${idx}">Same as Testator</button>
          </div>
        </div>
      </div>

      <div class="row person-card-row person-toggle-row">
        <div class="col-12 person-toggle">
          <label>Suffix</label>
          <div class="toggle-wrapper">${suffixToggle}</div>
        </div>
      </div>

      <div class="row person-card-row person-name-extras ${suffixEnabled ? "" : "hidden-field"}" data-person-section="suffix" data-idx="${idx}">
        <div class="col-12 person-field">
          <select class="person-input" data-field="suffix" data-idx="${idx}">${suffixOptions}</select>
        </div>
      </div>

      <div class="row person-card-row person-toggle-row">
        <div class="col-6 person-toggle">
          <label>Address</label>
          <div class="toggle-wrapper">${addressToggle}</div>
        </div>
      </div>

      <div class="person-address-block ${addressSectionClass}" data-person-section="address" data-idx="${idx}">
        <div class="person-address-actions">
          <button type="button" class="btn-helper person-address-same" data-idx="${idx}">Same as Client</button>
        </div>
        <div class="row person-card-row">
          <div class="col-12 person-field">
            <label>Street</label>
            <input type="text" class="person-input" data-field="addressStreet1" data-idx="${idx}" value="${escapeHtml(addressStreet1)}" placeholder="Street address">
          </div>
          <div class="col-12 person-field">
            <label>Street 2 (optional)</label>
            <input type="text" class="person-input" data-field="addressStreet2" data-idx="${idx}" value="${escapeHtml(addressStreet2)}" placeholder="Apartment, suite, etc.">
          </div>
        </div>
        <div class="row person-card-row">
          <div class="col-4 person-field">
            <label>City</label>
            <input type="text" class="person-input" data-field="addressCity" data-idx="${idx}" value="${escapeHtml(addressCity)}" placeholder="City">
          </div>
          <div class="col-4 person-field">
            <label>County</label>
            <select class="person-input" data-field="addressCounty" data-idx="${idx}">${countyOptions}</select>
          </div>
          <div class="col-4 person-field">
            <label>State</label>
            <select class="person-input" data-field="addressState" data-idx="${idx}">${stateOptions}</select>
          </div>
        </div>
        <div class="row person-card-row">
          <div class="col-4 person-field">
            <label>ZIP</label>
            <input type="text" class="person-input" data-field="addressZip" data-idx="${idx}" value="${escapeHtml(addressZip)}" placeholder="ZIP">
          </div>
        </div>
      </div>

      <div class="row person-card-row dob-row">
        <div class="col-4 person-field">
          <label>Birth month</label>
          <select class="person-input person-dob-month" data-field="dobMonth" data-idx="${idx}">${buildMonthOptions(dobMonth)}</select>
        </div>
        <div class="col-4 person-field">
          <label>Birth day</label>
          <input type="number" class="person-input person-dob-day" data-field="dobDay" data-idx="${idx}" min="1" max="${maxDay}" value="${escapeHtml(dobDay)}" placeholder="Day">
        </div>
        <div class="col-4 person-field">
          <label>Birth year</label>
          <select class="person-input person-dob-year" data-field="dobYear" data-idx="${idx}">${buildYearOptions(dobYear)}</select>
        </div>
      </div>

      <div class="person-roles-edit">
        <div class="person-primary-role">
          <label>Relationship</label>
          <select class="person-primary-select" data-idx="${idx}">${primaryRoleOptions}</select>
        </div>
        <div class="person-role-badges">
          <span class="roles-label">Badges</span>
          <div class="role-checks-inline">
            ${roleChecks}
          </div>
        </div>
      </div>
      ${childDetailsHtml}
    </div>
  </div>`;
}

// Render charity card for Name Bank
function renderCharityCard(charity, idx, allEntities = [], intake = null) {
  const charityData = charity || {};
  const displayName = charityData.charityName || `Charity ${idx + 1}`;
  const viewMode = charityData.viewMode === "summary" ? "summary" : "edit";
  const cardClasses = ["person-card", "charity-card", `person-card--${viewMode}`];
  
  const actionButtons = viewMode === "summary"
    ? [
        `<button type="button" class="btn-small person-edit" data-idx="${idx}">Edit card</button>`,
        `<button type="button" class="btn-small btn-remove remove-person" data-idx="${idx}">Remove</button>`
      ]
    : [
        `<button type="button" class="btn-small btn-primary person-save" data-idx="${idx}">Save card</button>`,
        `<button type="button" class="btn-small btn-remove remove-person" data-idx="${idx}">Remove</button>`
      ];
  const actionsHtml = actionButtons.join("");

  if (viewMode === "summary") {
    let summaryParts = [];
    if (charityData.charityPurpose) summaryParts.push(`Type: ${charityData.charityPurpose}`);
    if (charityData.charityEIN) summaryParts.push(`EIN: ${charityData.charityEIN}`);
    if (charityData.charityStreet1) {
      let addr = charityData.charityStreet1;
      if (charityData.charityCity) addr += `, ${charityData.charityCity}`;
      if (charityData.charityState) addr += `, ${charityData.charityState}`;
      summaryParts.push(addr);
    }
    if (charityData.charityEmail) summaryParts.push(`Email: ${charityData.charityEmail}`);
    if (charityData.charityPhone) summaryParts.push(`Phone: ${charityData.charityPhone}`);
    
    const summaryHtml = summaryParts.length ? summaryParts.map(p => `<div class="person-summary-line">${escapeHtml(p)}</div>`).join('') : '<div class="person-summary-line muted">No details</div>';
    
    return `<div class="${cardClasses.join(" ")}" data-idx="${idx}" data-mode="${viewMode}">
      <div class="person-card-head">
        <div class="person-card-title">🏛️ ${escapeHtml(displayName)}</div>
        <div class="person-card-actions">${actionsHtml}</div>
      </div>
      <div class="person-card-body person-card-summary">
        ${summaryHtml}
      </div>
    </div>`;
  }

  // Edit mode
  const purposeOptions = CHARITY_PURPOSES.map(p => 
    `<option value="${p}" ${charityData.charityPurpose === p ? 'selected' : ''}>${p}</option>`
  ).join('');

  return `<div class="${cardClasses.join(" ")}" data-idx="${idx}" data-mode="${viewMode}">
    <div class="person-card-head">
      <div class="person-card-title">🏛️ ${escapeHtml(displayName)}</div>
      <div class="person-card-actions">${actionsHtml}</div>
    </div>
    <div class="person-card-body person-card-edit">
      <div class="person-name-fields">
        <div class="person-field">
          <label>Charity Name *</label>
          <input type="text" class="person-input" data-field="charityName" data-idx="${idx}" value="${escapeHtml(charityData.charityName || '')}" placeholder="e.g., American Red Cross" required>
        </div>
      </div>

      <div class="person-field">
        <label>Purpose/Type</label>
        <select class="person-input" data-field="charityPurpose" data-idx="${idx}">
          <option value="">— Select Purpose —</option>
          ${purposeOptions}
        </select>
      </div>

      <div class="person-field">
        <label>EIN (Tax ID)</label>
        <input type="text" class="person-input" data-field="charityEIN" data-idx="${idx}" value="${escapeHtml(charityData.charityEIN || '')}" placeholder="e.g., 12-3456789">
      </div>

      <div class="person-address-section">
        <div class="person-field">
          <label>Street Address</label>
          <input type="text" class="person-input" data-field="charityStreet1" data-idx="${idx}" value="${escapeHtml(charityData.charityStreet1 || '')}" placeholder="Street Address">
        </div>
        <div class="person-field">
          <label>Street Address 2</label>
          <input type="text" class="person-input" data-field="charityStreet2" data-idx="${idx}" value="${escapeHtml(charityData.charityStreet2 || '')}" placeholder="Apt, Suite, Floor (optional)">
        </div>
        <div class="person-address-row">
          <div class="person-field">
            <label>City</label>
            <input type="text" class="person-input" data-field="charityCity" data-idx="${idx}" value="${escapeHtml(charityData.charityCity || '')}" placeholder="City">
          </div>
          <div class="person-field">
            <label>State</label>
            <select class="person-input" data-field="charityState" data-idx="${idx}">
              <option value="">— Select State —</option>
              ${optionsHtml(STATES, charityData.charityState || '')}
            </select>
          </div>
          <div class="person-field">
            <label>ZIP Code</label>
            <input type="text" class="person-input" data-field="charityZip" data-idx="${idx}" value="${escapeHtml(charityData.charityZip || '')}" placeholder="ZIP">
          </div>
        </div>
      </div>

      <div class="person-contact-fields">
        <div class="person-field">
          <label>Email</label>
          <input type="email" class="person-input" data-field="charityEmail" data-idx="${idx}" value="${escapeHtml(charityData.charityEmail || '')}" placeholder="contact@charity.org">
        </div>
        <div class="person-field">
          <label>Phone</label>
          <input type="tel" class="person-input" data-field="charityPhone" data-idx="${idx}" value="${escapeHtml(charityData.charityPhone || '')}" placeholder="(555) 123-4567">
        </div>
      </div>
    </div>
  </div>`;
}

// Render corporate fiduciary card for Name Bank
function renderCorporateCard(corporate, idx, allEntities = [], intake = null) {
  const corporateData = corporate || {};
  const displayName = corporateData.charityName || `Corporate Fiduciary ${idx + 1}`;
  const viewMode = corporateData.viewMode === "summary" ? "summary" : "edit";
  const cardClasses = ["person-card", "corporate-card", `person-card--${viewMode}`];
  
  const actionButtons = viewMode === "summary"
    ? [
        `<button type="button" class="btn-small person-edit" data-idx="${idx}">Edit card</button>`,
        `<button type="button" class="btn-small btn-remove remove-person" data-idx="${idx}">Remove</button>`
      ]
    : [
        `<button type="button" class="btn-small btn-primary person-save" data-idx="${idx}">Save card</button>`,
        `<button type="button" class="btn-small btn-remove remove-person" data-idx="${idx}">Remove</button>`
      ];
  const actionsHtml = actionButtons.join("");

  if (viewMode === "summary") {
    let summaryParts = [];
    if (corporateData.charityEIN) summaryParts.push(`EIN: ${corporateData.charityEIN}`);
    if (corporateData.charityStreet1) {
      let addr = corporateData.charityStreet1;
      if (corporateData.charityCity) addr += `, ${corporateData.charityCity}`;
      if (corporateData.charityState) addr += `, ${corporateData.charityState}`;
      summaryParts.push(addr);
    }
    if (corporateData.charityEmail) summaryParts.push(`Email: ${corporateData.charityEmail}`);
    if (corporateData.charityPhone) summaryParts.push(`Phone: ${corporateData.charityPhone}`);
    
    const summaryHtml = summaryParts.length ? summaryParts.map(p => `<div class="person-summary-line">${escapeHtml(p)}</div>`).join('') : '<div class="person-summary-line muted">No details</div>';
    
    return `<div class="${cardClasses.join(" ")}" data-idx="${idx}" data-mode="${viewMode}">
      <div class="person-card-head">
        <div class="person-card-title">🏢 ${escapeHtml(displayName)}</div>
        <div class="person-card-actions">${actionsHtml}</div>
      </div>
      <div class="person-card-body person-card-summary">
        ${summaryHtml}
      </div>
    </div>`;
  }

  // Edit mode
  return `<div class="${cardClasses.join(" ")}" data-idx="${idx}" data-mode="${viewMode}">
    <div class="person-card-head">
      <div class="person-card-title">🏢 ${escapeHtml(displayName)}</div>
      <div class="person-card-actions">${actionsHtml}</div>
    </div>
    <div class="person-card-body person-card-edit">
      <div class="person-name-fields">
        <div class="person-field">
          <label>Corporate Name *</label>
          <input type="text" class="person-input" data-field="charityName" data-idx="${idx}" value="${escapeHtml(corporateData.charityName || '')}" placeholder="e.g., Acme Trust Company" required>
        </div>
      </div>

      <div class="person-field">
        <label>EIN (Tax ID)</label>
        <input type="text" class="person-input" data-field="charityEIN" data-idx="${idx}" value="${escapeHtml(corporateData.charityEIN || '')}" placeholder="e.g., 12-3456789">
      </div>

      <div class="person-address-section">
        <div class="person-field">
          <label>Street Address</label>
          <input type="text" class="person-input" data-field="charityStreet1" data-idx="${idx}" value="${escapeHtml(corporateData.charityStreet1 || '')}" placeholder="Street Address">
        </div>
        <div class="person-field">
          <label>Street Address 2</label>
          <input type="text" class="person-input" data-field="charityStreet2" data-idx="${idx}" value="${escapeHtml(corporateData.charityStreet2 || '')}" placeholder="Apt, Suite, Floor (optional)">
        </div>
        <div class="person-address-row">
          <div class="person-field">
            <label>City</label>
            <input type="text" class="person-input" data-field="charityCity" data-idx="${idx}" value="${escapeHtml(corporateData.charityCity || '')}" placeholder="City">
          </div>
          <div class="person-field">
            <label>State</label>
            <select class="person-input" data-field="charityState" data-idx="${idx}">
              <option value="">— Select State —</option>
              ${optionsHtml(STATES, corporateData.charityState || '')}
            </select>
          </div>
          <div class="person-field">
            <label>ZIP Code</label>
            <input type="text" class="person-input" data-field="charityZip" data-idx="${idx}" value="${escapeHtml(corporateData.charityZip || '')}" placeholder="ZIP">
          </div>
        </div>
      </div>

      <div class="person-contact-fields">
        <div class="person-field">
          <label>Email</label>
          <input type="email" class="person-input" data-field="charityEmail" data-idx="${idx}" value="${escapeHtml(corporateData.charityEmail || '')}" placeholder="contact@company.com">
        </div>
        <div class="person-field">
          <label>Phone</label>
          <input type="tel" class="person-input" data-field="charityPhone" data-idx="${idx}" value="${escapeHtml(corporateData.charityPhone || '')}" placeholder="(555) 123-4567">
        </div>
      </div>
    </div>
  </div>`;
}

// Event binding for all form elements
function bindFormEvents() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  
  // Standard input binding with App.state and Bus events
  tabContent.querySelectorAll("input, select, textarea").forEach(el => {
    const fieldId = el.dataset.field || el.id;
    if (!fieldId) return;

    const isCheckbox = el.type === "checkbox";
    const isSelect = el.tagName === "SELECT";
    const eventName = (isCheckbox || isSelect) ? "change" : "input";
    const handler = () => {
      let value;
      if (isCheckbox) {
        value = el.checked;
      } else if (isSelect && el.multiple) {
        value = Array.from(el.selectedOptions).map(option => option.value);
      } else {
        value = el.value;
      }

      if (isSelect && el.dataset.syncTarget) {
        const targetId = el.dataset.syncTarget;
        const target = targetId ? tabContent.querySelector(`#${targetId}`) : null;
        const selectedOption = el.multiple ? null : el.selectedOptions[0] || null;
        const displayValue = selectedOption ? (selectedOption.dataset.display || selectedOption.textContent || selectedOption.value) : '';
        if (target) {
          target.value = displayValue;
          const targetField = target.dataset.field || target.id;
          if (targetField) {
            Bus.emit('form-change', {
              field: targetField,
              value: displayValue,
              element: target
            });
          }
        }
      }

      if (isSelect && el.dataset.syncDisplayField) {
        const displayValues = Array.from(el.selectedOptions)
          .map(option => option.dataset.display || option.textContent || option.value)
          .filter(display => display !== undefined && display !== null && String(display).trim() !== '');
        Bus.emit('form-change', {
          field: el.dataset.syncDisplayField,
          value: displayValues,
          element: el
        });
      }

      Bus.emit('form-change', {
        field: fieldId,
        value,
        element: el
      });
    };

    el.addEventListener(eventName, handler);
  });

  // Clause selection via dropdown
  tabContent.querySelectorAll(".clause-select").forEach(select => {
    select.addEventListener("change", () => {
      const articleKey = select.dataset.article;
      const selectedValue = select.value;
      const existingSelections = App.state.selectedClauses || {};
      const currentList = existingSelections[articleKey] || [];
      const normalizedCurrent = currentList
        .map(id => resolveClauseId(articleKey, id))
        .filter(Boolean);
  const addonSelections = normalizedCurrent.filter(id => isAddonClause(articleKey, id));
  const resolvedPrimary = selectedValue ? resolveClauseId(articleKey, selectedValue) : "";
  const baseSelections = resolvedPrimary ? [resolvedPrimary] : [];
  const combined = Array.from(new Set([...baseSelections, ...addonSelections]));
      App.setState({
        selectedClauses: {
          ...existingSelections,
          [articleKey]: combined
        }
      });
      Bus.emit('preview-update');
      updateAddonUI(articleKey);
      
      // Re-render dynamic fields if this is residuary tab
      if (articleKey === 'residuary') {
        renderTab(currentArticle);
      }
    });
  });

  tabContent.querySelectorAll('.clause-selection-panel').forEach(panel => {
    bindAddonControls(panel);
    bindPowersChecklist(panel);
    bindMiscChecklist(panel);
    bindTrustsPanel(panel);
  });
  
  // Segmented controls
  tabContent.querySelectorAll(".seg-btn").forEach(btn => {
    const fieldId = btn.dataset.field;
    if (!fieldId) return; // Name bank child buttons manage their own state
    btn.addEventListener("click", () => {
      const value = btn.dataset.value;
      
      // Update UI
      btn.parentElement.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // Persist through centralized flow so preview + App.state stay in sync
      Bus.emit('form-change', {
        field: fieldId,
        value,
        element: btn
      });
    });
  });

  // Toggle extra fields
  tabContent.querySelectorAll(".toggle-extra-btn").forEach(btn => {
    if (!btn.id) return; // Skip inline buttons that manage name bank cards
    btn.addEventListener("click", () => {
      const fieldId = btn.id;
      const isActive = !btn.classList.contains("active");
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-expanded", isActive);
      btn.setAttribute("aria-pressed", isActive);
      const icon = btn.querySelector(".toggle-icon");
      if (icon) {
        icon.textContent = isActive ? "−" : "+";
      }
      Bus.emit('form-change', {
        field: fieldId,
        value: isActive,
        element: btn
      });
      updateConditionalFields();
    });
  });

  // Checkbox toggle buttons (styled like toggle-extra-btn)
  tabContent.querySelectorAll(".checkbox-toggle-btn").forEach(btn => {
    if (!btn.id) return;
    btn.addEventListener("click", () => {
      const fieldId = btn.id;
      const isActive = !btn.classList.contains("active");
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive);
      const icon = btn.querySelector(".checkbox-icon");
      if (icon) {
        icon.textContent = isActive ? "☑" : "☐";
      }
      Bus.emit('form-change', {
        field: fieldId,
        value: isActive,
        element: btn
      });
    });
  });

  // Action buttons
  tabContent.querySelectorAll('button[data-action="toggle-off"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (!target) return;
      const toggleBtn = document.getElementById(target);
      if (toggleBtn && toggleBtn.classList.contains("toggle-extra-btn")) {
        toggleBtn.classList.remove("active");
        toggleBtn.setAttribute("aria-expanded", "false");
        toggleBtn.setAttribute("aria-pressed", "false");
        const icon = toggleBtn.querySelector(".toggle-icon");
        if (icon) {
          icon.textContent = "+";
        }
      }
      Bus.emit('form-change', {
        field: target,
        value: false,
        element: btn
      });
      updateConditionalFields();
    });
  });
  
  // Checkbox groups
  tabContent.querySelectorAll(".checks, .checks-2col, .checks-inline, .multi-addons").forEach(container => {
    const fieldId = container.id;
    if (!fieldId) return;
    
    container.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        const checked = Array.from(container.querySelectorAll("input[type=checkbox]:checked"))
                           .map(input => input.value);
        writeIntake({ [fieldId]: checked });
        debouncedRender();
      });
    });
  });
  
  // Radio groups
  tabContent.querySelectorAll(".radio-group").forEach(container => {
    const fieldId = container.id;
    if (!fieldId) return;
    
    container.querySelectorAll("input[type=radio]").forEach(radio => {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          writeIntake({ [fieldId]: radio.value });
          debouncedRender();
        }
      });
    });
  });
  
  // Repeat controls
  tabContent.querySelectorAll(".repeat-add").forEach(btn => {
    btn.addEventListener("click", () => {
      const fieldId = btn.dataset.field;
      const container = document.getElementById(fieldId);
      const currentValues = readIntake()[fieldId] || [];
      const newValues = [...currentValues, ""];
      writeIntake({ [fieldId]: newValues });
      renderTab(currentArticle);
    });
  });
  
  tabContent.querySelectorAll(".repeat-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const container = btn.closest(".repeat-container");
      const fieldId = container.id;
      const currentValues = readIntake()[fieldId] || [];
      const newValues = currentValues.filter((_, i) => i !== idx);
      writeIntake({ [fieldId]: newValues });
      renderTab(currentArticle);
    });
  });
  
  tabContent.querySelectorAll(".repeat-select").forEach(select => {
    select.addEventListener("change", () => {
      const idx = parseInt(select.dataset.idx);
      const container = select.closest(".repeat-container");
      const fieldId = container.id;
      const currentValues = readIntake()[fieldId] || [];
      currentValues[idx] = select.value;
      writeIntake({ [fieldId]: [...currentValues] });
      debouncedRender();
    });
  });
  
  // Name bank controls
  bindNameBankEvents();
  
  // Gifts controls
  bindGiftsEvents();
  
  // Dynamic clause fields (residuary charity selections, etc.)
  bindDynamicClauseFieldsEvents();
  
  // Client info edit button
  bindClientInfoEvents();
  
  // Family members interactions
  bindFamilyMembersEvents();
}

// Dynamic clause fields event handlers (charity selections, backup charities, etc.)
function bindDynamicClauseFieldsEvents() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;

  // Go to name bank buttons when no charities exist
  tabContent.querySelectorAll(".go-to-namebank").forEach(btn => {
    btn.addEventListener("click", () => {
      setActiveTab("namebank");
    });
  });
  
  // Backup charity selection dropdowns
  tabContent.querySelectorAll(".backup-charity-select").forEach(select => {
    select.addEventListener("change", () => {
      const idx = parseInt(select.dataset.idx);
      updateBackupCharityEntry(idx, 'charityId', select.value);
      updateBackupCharityTotal();
    });
  });
  
  // Backup charity percentage inputs
  tabContent.querySelectorAll(".backup-charity-percent").forEach(input => {
    input.addEventListener("input", () => {
      const idx = parseInt(input.dataset.idx);
      let value = input.value;
      
      // Validate and constrain percentage
      if (value !== '') {
        let numValue = parseFloat(value);
        if (isNaN(numValue)) {
          numValue = 0;
        }
        // Don't allow negative
        if (numValue < 0) {
          numValue = 0;
          input.value = '0';
        }
        // Don't allow more than 100 for individual entry
        if (numValue > 100) {
          numValue = 100;
          input.value = '100';
        }
        value = numValue.toString();
      }
      
      // Update this entry first
      updateBackupCharityEntry(idx, 'percentage', value);
      
      // Then redistribute other charities proportionally
      redistributePercentagesProportionally(idx, value);
      
      // Re-render to show updated percentages
      renderTab(currentArticle);
    });
  });
  
  // Add backup charity button
  tabContent.querySelectorAll(".add-backup-charity").forEach(btn => {
    btn.addEventListener("click", () => {
      addBackupCharityEntry();
    });
  });
  
  // Remove backup charity buttons
  tabContent.querySelectorAll(".remove-backup-charity").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      removeBackupCharityEntry(idx);
    });
  });
  
  // Alternate beneficiary selection dropdowns
  tabContent.querySelectorAll(".alternate-beneficiary-select").forEach(select => {
    select.addEventListener("change", () => {
      const idx = parseInt(select.dataset.idx);
      updateAlternateBeneficiaryEntry(idx, select.value);
    });
  });
  
  // Add alternate beneficiary button
  tabContent.querySelectorAll(".add-alternate-beneficiary").forEach(btn => {
    btn.addEventListener("click", () => {
      addAlternateBeneficiaryEntry();
    });
  });
  
  // Remove alternate beneficiary buttons
  tabContent.querySelectorAll(".remove-alternate-beneficiary").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      removeAlternateBeneficiaryEntry(idx);
    });
  });
  
  // Alternate executor selection dropdowns
  tabContent.querySelectorAll(".alternate-executor-select").forEach(select => {
    select.addEventListener("change", () => {
      const idx = parseInt(select.dataset.idx);
      updateAlternateExecutorEntry(idx, select.value);
    });
  });
  
  // Add alternate executor button
  tabContent.querySelectorAll(".add-alternate-executor").forEach(btn => {
    btn.addEventListener("click", () => {
      addAlternateExecutorEntry();
    });
  });
  
  // Remove alternate executor buttons
  tabContent.querySelectorAll(".remove-alternate-executor").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      removeAlternateExecutorEntry(idx);
    });
  });
}

// Update an alternate beneficiary entry
function updateAlternateBeneficiaryEntry(idx, personId) {
  const intake = readIntake();
  const alternateBeneficiaries = [...(intake.AlternateBeneficiaries || [])];
  
  // Ensure entry exists
  while (alternateBeneficiaries.length <= idx) {
    alternateBeneficiaries.push({ personId: '' });
  }
  
  alternateBeneficiaries[idx] = { personId };
  
  writeIntake({ AlternateBeneficiaries: alternateBeneficiaries });
  App.setState({ intake: { ...App.state.intake, AlternateBeneficiaries: alternateBeneficiaries } });
  Bus.emit('preview-update');
}

// Add a new alternate beneficiary entry
function addAlternateBeneficiaryEntry() {
  const intake = readIntake();
  const alternateBeneficiaries = [...(intake.AlternateBeneficiaries || [])];
  alternateBeneficiaries.push({ personId: '' });
  
  writeIntake({ AlternateBeneficiaries: alternateBeneficiaries });
  App.setState({ intake: { ...App.state.intake, AlternateBeneficiaries: alternateBeneficiaries } });
  
  // Re-render to show new entry
  renderTab(currentArticle);
}

// Remove an alternate beneficiary entry
function removeAlternateBeneficiaryEntry(idx) {
  const intake = readIntake();
  const alternateBeneficiaries = [...(intake.AlternateBeneficiaries || [])];
  alternateBeneficiaries.splice(idx, 1);
  
  writeIntake({ AlternateBeneficiaries: alternateBeneficiaries });
  App.setState({ intake: { ...App.state.intake, AlternateBeneficiaries: alternateBeneficiaries } });
  
  // Re-render to update UI
  renderTab(currentArticle);
  Bus.emit('preview-update');
}

// Update an alternate executor entry
function updateAlternateExecutorEntry(idx, personId) {
  const intake = readIntake();
  const alternateExecutors = [...(intake.AlternateExecutors || [])];
  
  // Ensure entry exists
  while (alternateExecutors.length <= idx) {
    alternateExecutors.push({ personId: '' });
  }
  
  alternateExecutors[idx] = { personId };
  
  writeIntake({ AlternateExecutors: alternateExecutors });
  App.setState({ intake: { ...App.state.intake, AlternateExecutors: alternateExecutors } });
  Bus.emit('preview-update');
}

// Add a new alternate executor entry
function addAlternateExecutorEntry() {
  const intake = readIntake();
  const alternateExecutors = [...(intake.AlternateExecutors || [])];
  alternateExecutors.push({ personId: '' });
  
  writeIntake({ AlternateExecutors: alternateExecutors });
  App.setState({ intake: { ...App.state.intake, AlternateExecutors: alternateExecutors } });
  
  // Re-render to show new entry
  renderTab(currentArticle);
}

// Remove an alternate executor entry
function removeAlternateExecutorEntry(idx) {
  const intake = readIntake();
  const alternateExecutors = [...(intake.AlternateExecutors || [])];
  alternateExecutors.splice(idx, 1);
  
  writeIntake({ AlternateExecutors: alternateExecutors });
  App.setState({ intake: { ...App.state.intake, AlternateExecutors: alternateExecutors } });
  
  // Re-render to update UI
  renderTab(currentArticle);
  Bus.emit('preview-update');
}

// Update a backup charity entry
function updateBackupCharityEntry(idx, field, value) {
  const intake = readIntake();
  const backupCharities = [...(intake.BackupCharities || [])];
  
  // Ensure entry exists
  while (backupCharities.length <= idx) {
    backupCharities.push({ charityId: '', percentage: '' });
  }
  
  backupCharities[idx] = {
    ...backupCharities[idx],
    [field]: value
  };
  
  writeIntake({ BackupCharities: backupCharities });
  App.setState({ intake: { ...App.state.intake, BackupCharities: backupCharities } });
  Bus.emit('preview-update');
}

// Update backup charity total display
function updateBackupCharityTotal() {
  const intake = readIntake();
  const backupCharities = intake.BackupCharities || [];
  
  const totalPercent = backupCharities.reduce((sum, entry) => {
    const percent = parseFloat(entry.percentage) || 0;
    return sum + percent;
  }, 0);
  
  // Check if any charities are unselected
  const hasUnselectedCharity = backupCharities.some(entry => !entry.charityId);
  
  const totalElement = document.getElementById('backupCharityTotal');
  const containerElement = totalElement?.closest('.backup-charity-total');
  
  if (totalElement && containerElement) {
    const isValid = totalPercent === 100 && !hasUnselectedCharity;
    const isOverLimit = totalPercent > 100;
    
    // Update display
    totalElement.textContent = `${totalPercent.toFixed(2)}%`;
    const remainingElement = containerElement.querySelector('.total-remaining');
    if (remainingElement) {
      remainingElement.textContent = `(${(100 - totalPercent).toFixed(2)}% remaining)`;
    }
    
    // Update status class
    containerElement.classList.remove('valid', 'error', 'warning');
    if (isValid) {
      containerElement.classList.add('valid');
    } else if (isOverLimit || hasUnselectedCharity) {
      containerElement.classList.add('error');
    } else {
      containerElement.classList.add('warning');
    }
    
    // Show/hide error messages
    const errorMsg = containerElement.parentElement?.querySelector('.error-message');
    const warningMsg = containerElement.parentElement?.querySelector('.warning-message');
    const unselectedMsg = containerElement.parentElement?.querySelector('.unselected-message');
    
    if (errorMsg) {
      errorMsg.style.display = isOverLimit ? 'block' : 'none';
      if (isOverLimit) {
        errorMsg.textContent = 'Error: Total exceeds 100%. Please adjust percentages.';
      }
    }
    if (warningMsg) {
      warningMsg.style.display = (!isValid && !isOverLimit && !hasUnselectedCharity && backupCharities.length > 0) ? 'block' : 'none';
    }
    if (unselectedMsg) {
      unselectedMsg.style.display = hasUnselectedCharity ? 'block' : 'none';
    } else if (hasUnselectedCharity && errorMsg) {
      // If no unselectedMsg element, use errorMsg
      errorMsg.style.display = 'block';
      errorMsg.textContent = 'Error: Please select a charity for all entries.';
    }
  }
}

// Redistribute percentages evenly across all charities
function redistributePercentagesEvenly() {
  const intake = readIntake();
  const backupCharities = [...(intake.BackupCharities || [])];
  
  if (backupCharities.length === 0) return;
  
  // Calculate even distribution
  const evenPercent = 100 / backupCharities.length;
  const roundedPercent = Math.round(evenPercent * 100) / 100; // Round to 2 decimals
  
  // Distribute evenly, adjusting FIRST entry to get remainder (appears larger at top)
  backupCharities.forEach((entry, idx) => {
    if (idx === 0) {
      // First entry gets remainder to ensure exactly 100% and appears larger
      const totalForOthers = roundedPercent * (backupCharities.length - 1);
      entry.percentage = (100 - totalForOthers).toFixed(2);
    } else {
      entry.percentage = roundedPercent.toFixed(2);
    }
  });
  
  writeIntake({ BackupCharities: backupCharities });
  App.setState({ intake: { ...App.state.intake, BackupCharities: backupCharities } });
}

// Redistribute percentages proportionally when one changes
function redistributePercentagesProportionally(changedIdx, newValue) {
  const intake = readIntake();
  const backupCharities = [...(intake.BackupCharities || [])];
  
  if (backupCharities.length <= 1) {
    // Only one charity, set to 100%
    backupCharities[0].percentage = '100';
    writeIntake({ BackupCharities: backupCharities });
    App.setState({ intake: { ...App.state.intake, BackupCharities: backupCharities } });
    return;
  }
  
  const newPercent = parseFloat(newValue) || 0;
  const remaining = 100 - newPercent;
  
  // Get current percentages of other charities (excluding the changed one)
  const otherCharities = backupCharities
    .map((entry, idx) => ({ idx, percent: parseFloat(entry.percentage) || 0 }))
    .filter(item => item.idx !== changedIdx);
  
  const currentOtherTotal = otherCharities.reduce((sum, item) => sum + item.percent, 0);
  
  // Redistribute remaining percentage proportionally among other charities
  if (currentOtherTotal > 0) {
    otherCharities.forEach(item => {
      const proportion = item.percent / currentOtherTotal;
      backupCharities[item.idx].percentage = (remaining * proportion).toFixed(2);
    });
  } else {
    // If other charities have no percentage, distribute evenly
    const evenPercent = remaining / otherCharities.length;
    otherCharities.forEach((item, localIdx) => {
      // Give first charity (lowest global index) the remainder
      const isFirstCharity = item.idx === Math.min(...otherCharities.map(c => c.idx));
      if (isFirstCharity) {
        // First one gets remainder
        const totalForOthers = evenPercent * (otherCharities.length - 1);
        backupCharities[item.idx].percentage = (remaining - totalForOthers).toFixed(2);
      } else {
        backupCharities[item.idx].percentage = evenPercent.toFixed(2);
      }
    });
  }
  
  // Ensure the changed entry has the exact value entered
  backupCharities[changedIdx].percentage = newPercent.toFixed(2);
  
  // Final adjustment to ensure exactly 100% (handle rounding errors)
  const finalTotal = backupCharities.reduce((sum, entry) => sum + parseFloat(entry.percentage), 0);
  if (Math.abs(finalTotal - 100) > 0.01) {
    // Adjust the first charity that's not the changed one (to keep larger percentage at top)
    const firstOtherIdx = Math.min(...otherCharities.map(c => c.idx));
    const adjustment = 100 - finalTotal;
    backupCharities[firstOtherIdx].percentage = (parseFloat(backupCharities[firstOtherIdx].percentage) + adjustment).toFixed(2);
  }
  
  writeIntake({ BackupCharities: backupCharities });
  App.setState({ intake: { ...App.state.intake, BackupCharities: backupCharities } });
}

// Add new backup charity entry
function addBackupCharityEntry() {
  const intake = readIntake();
  const backupCharities = [...(intake.BackupCharities || [])];
  backupCharities.push({ charityId: '', percentage: '0' });
  
  // Redistribute percentages evenly
  writeIntake({ BackupCharities: backupCharities });
  App.setState({ intake: { ...App.state.intake, BackupCharities: backupCharities } });
  
  // Redistribute after state update
  setTimeout(() => {
    redistributePercentagesEvenly();
    renderTab(currentArticle);
  }, 0);
}

// Remove backup charity entry
function removeBackupCharityEntry(idx) {
  const intake = readIntake();
  const backupCharities = [...(intake.BackupCharities || [])];
  backupCharities.splice(idx, 1);
  
  writeIntake({ BackupCharities: backupCharities });
  App.setState({ intake: { ...App.state.intake, BackupCharities: backupCharities } });
  
  // Redistribute after removal
  if (backupCharities.length > 0) {
    setTimeout(() => {
      redistributePercentagesEvenly();
      renderTab(currentArticle);
    }, 0);
  } else {
    renderTab(currentArticle);
  }
}

// Client info event handlers
function bindClientInfoEvents() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  
  const editBtn = tabContent.querySelector("#editTestatorInfo");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      // Switch to testator tab
      setActiveTab("testator");
    });
  }
  
  const namebankBtn = tabContent.querySelector("#goToNameBank");
  if (namebankBtn) {
    namebankBtn.addEventListener("click", () => {
      // Switch to name bank tab
      setActiveTab("namebank");
    });
  }
}

// Family members event handlers
function bindFamilyMembersEvents() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  
  // Member input fields
  tabContent.querySelectorAll(".member-input").forEach(input => {
    const eventName = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(eventName, (e) => {
      const field = e.target.dataset.field;
      const personId = e.target.dataset.person;
      const value = e.target.value;
      
      saveFamilyMemberData(personId, field, value);
    });
  });
  
  // Segmented controls for child type
  tabContent.querySelectorAll(".family-member-card .seg-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const field = e.target.dataset.field;
      const value = e.target.dataset.value;
      const personId = e.target.dataset.person;
      
      // Update UI
      const container = e.target.closest(".seg-control");
      container.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      
      // Save data
      saveFamilyMemberData(personId, field, value);
    });
  });
  
  // Same as testator address buttons
  tabContent.querySelectorAll(".member-same-address").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const personId = e.target.dataset.person;
      populateTestatorAddress(personId);
    });
  });

  applyFamilyMemberDefaults();
  updateConditionalFields();
}

// Save family member data to intake state
function saveFamilyMemberData(personId, field, value, options = {}) {
  const { suppressRender = false } = options;
  const intake = readIntake();
  const memberKey = `FamilyMember_${personId}`;
  const existingData = intake[memberKey] || {};
  const updatedData = { ...existingData, [field]: value };

  const card = document.querySelector(`[data-person-id="${personId}"]`);
  const role = card?.dataset.role || "";

  if (role === "Child") {
    if (!updatedData.parentA) {
      updatedData.parentA = "CLIENT";
    }

    if (!updatedData.childType) {
      updatedData.childType = "Biological";
    }

    if (field === "childType") {
      if (value === "Biological") {
        delete updatedData.treatAsBio;
      } else if (existingData.treatAsBio === undefined) {
        updatedData.treatAsBio = "Yes";
      }
    }

    if (!updatedData.parentB) {
      if (!(field === "parentB" && value === "")) {
        const fallbackParent = listPeopleByRole(intake, "Spouse")[0];
        if (fallbackParent?.id) {
          updatedData.parentB = fallbackParent.id;
        }
      }
    }
  }

  writeIntake({ [memberKey]: updatedData });
  if (!suppressRender) {
    debouncedRender();
  }
}

// Populate testator address for a family member
function populateTestatorAddress(personId) {
  const intake = readIntake();
  
  // Get testator address data
  const testatorAddress = {
    street1: intake.ClientStreet1 || "",
    street2: intake.ClientStreet2 || "",
    city: intake.ClientCity || "",
    county: intake.DomicileCounty || "",
    state: intake.DomicileState || "New Jersey",
    zip: intake.ClientZip || ""
  };
  
  // Check if testator has address information
  if (!testatorAddress.street1 && !testatorAddress.city) {
    alert("Please enter the testator's address in the Testator tab first.");
    return;
  }
  
  // Update the form fields for this person
  const card = document.querySelector(`[data-person-id="${personId}"]`);
  if (card) {
    Object.entries(testatorAddress).forEach(([field, value]) => {
      const input = card.querySelector(`[data-field="${field}"][data-person="${personId}"]`);
      if (input) {
        input.value = value;
        // Trigger the input event to save the data
        input.dispatchEvent(new Event('input'));
      }
    });
  }
}

function applyFamilyMemberDefaults() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  const intake = readIntake();
  let defaultsApplied = false;

  tabContent.querySelectorAll(".family-member-card[data-role=\"Child\"]").forEach(card => {
    const personId = card.dataset.personId;
    if (!personId) return;
    const memberKey = `FamilyMember_${personId}`;
    const memberData = intake[memberKey] || {};

    if (!memberData.parentA) {
      saveFamilyMemberData(personId, "parentA", "CLIENT", { suppressRender: true });
      defaultsApplied = true;
    }

    if (!memberData.childType) {
      saveFamilyMemberData(personId, "childType", "Biological", { suppressRender: true });
      defaultsApplied = true;
    }

    if (!memberData.parentB) {
      const fallbackParent = listPeopleByRole(intake, "Spouse")[0];
      if (fallbackParent?.id) {
        saveFamilyMemberData(personId, "parentB", fallbackParent.id, { suppressRender: true });
        defaultsApplied = true;
      }
    }

    if (memberData.childType && memberData.childType !== "Biological" && memberData.treatAsBio === undefined) {
      saveFamilyMemberData(personId, "treatAsBio", "Yes", { suppressRender: true });
      defaultsApplied = true;
    }
  });

  if (defaultsApplied) {
    debouncedRender();
  }
}

function updateConditionalFields(intakeOverride) {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  const intake = intakeOverride || readIntake();
  tabContent.querySelectorAll("[data-show-when-field]").forEach(wrapper => {
    const field = wrapper.dataset.showWhenField;
    const operator = wrapper.dataset.showWhenOperator || "equals";
    const raw = wrapper.dataset.showWhenValue || "";
    const actual = intake?.[field];
    let visible = true;

    const parseTargets = () => raw.split("||").map(token => token);

    switch (operator) {
      case "equals": {
        const targets = parseTargets();
        if (Array.isArray(actual)) {
          visible = actual.some(val => targets.includes(String(val)));
        } else {
          visible = targets.includes(String(actual ?? ""));
        }
        break;
      }
      case "notEquals": {
        const targets = parseTargets();
        if (Array.isArray(actual)) {
          visible = actual.every(val => !targets.includes(String(val)));
        } else {
          visible = !targets.includes(String(actual ?? ""));
        }
        break;
      }
      case "truthy":
        visible = Boolean(actual);
        break;
      case "falsy":
        visible = !actual;
        break;
      default:
        visible = true;
        break;
    }

    if (visible) {
      wrapper.classList.remove("hidden-field");
    } else {
      wrapper.classList.add("hidden-field");
    }
  });
}

// Gifts event handlers
function bindGiftsEvents() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  
  // Add gift button
  const addGiftBtn = tabContent.querySelector("#addGiftBtn");
  if (addGiftBtn) {
    addGiftBtn.addEventListener("click", () => {
      const intake = readIntake();
      const gifts = intake.SpecificGifts || [];
      const newGift = {
        id: `gift-${Date.now()}`,
        type: 'item',
        benRef: '',
        benCustom: '',
        amount: '',
        what: '',
        percent: '',
        rpAddr: '',
        digPlatform: '',
        digId: '',
        otherText: '',
        predecease: 'per_stirpes',
        alternates: '',
        notes: ''
      };
      const updatedGifts = [...gifts, newGift];
      const updatedIntake = writeIntake({ SpecificGifts: updatedGifts });
      App.setState({ intake: updatedIntake });
      renderTab('gifts');
      Bus.emit('preview-update');
    });
  }
  
  // Gift card controls
  tabContent.querySelectorAll(".gift-card").forEach(card => {
    const giftIndex = parseInt(card.dataset.giftIndex);
    
    // Type selector
    const typeSelect = card.querySelector(".gift-type");
    if (typeSelect) {
      typeSelect.addEventListener("change", () => {
        updateGiftField(giftIndex, 'type', typeSelect.value);
        // Show/hide relevant detail sections
        card.querySelectorAll(".gift-details > div").forEach(d => d.style.display = "none");
        const detailDiv = card.querySelector(`.gift-details-${typeSelect.value}`);
        if (detailDiv) detailDiv.style.display = "block";
        // Update badge
        const badge = card.querySelector(".gift-type-badge");
        const typeLabels = {
          'cash': 'Cash',
          'item': 'Specific Item',
          'percent': 'Percentage',
          'real_property': 'Real Property',
          'digital': 'Digital Asset',
          'other': 'Other'
        };
        if (badge) badge.textContent = typeLabels[typeSelect.value] || 'Gift';
      });
    }
    
    // Beneficiary selector
    const benSelect = card.querySelector(".gift-beneficiary");
    if (benSelect) {
      benSelect.addEventListener("change", () => {
        updateGiftField(giftIndex, 'benRef', benSelect.value);
      });
    }
    
    // Beneficiary custom
    const benCustom = card.querySelector(".gift-beneficiary-custom");
    if (benCustom) {
      benCustom.addEventListener("input", () => {
        updateGiftField(giftIndex, 'benCustom', benCustom.value);
      });
    }
    
    // Type-specific fields
    const amountInput = card.querySelector(".gift-amount");
    if (amountInput) {
      amountInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'amount', amountInput.value);
      });
    }
    
    const whatInput = card.querySelector(".gift-item-what");
    if (whatInput) {
      whatInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'what', whatInput.value);
      });
    }
    
    const percentInput = card.querySelector(".gift-percent");
    if (percentInput) {
      percentInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'percent', percentInput.value);
      });
    }
    
    const rpAddrInput = card.querySelector(".gift-rp-address");
    if (rpAddrInput) {
      rpAddrInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'rpAddr', rpAddrInput.value);
      });
    }
    
    const digPlatformInput = card.querySelector(".gift-dig-platform");
    if (digPlatformInput) {
      digPlatformInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'digPlatform', digPlatformInput.value);
      });
    }
    
    const digIdInput = card.querySelector(".gift-dig-id");
    if (digIdInput) {
      digIdInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'digId', digIdInput.value);
      });
    }
    
    const otherTextInput = card.querySelector(".gift-other-text");
    if (otherTextInput) {
      otherTextInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'otherText', otherTextInput.value);
      });
    }
    
    // Predecease handling
    const predeceaseSelect = card.querySelector(".gift-predecease");
    if (predeceaseSelect) {
      predeceaseSelect.addEventListener("change", () => {
        updateGiftField(giftIndex, 'predecease', predeceaseSelect.value);
      });
    }
    
    const alternatesInput = card.querySelector(".gift-alternates");
    if (alternatesInput) {
      alternatesInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'alternates', alternatesInput.value);
      });
    }
    
    const notesInput = card.querySelector(".gift-notes");
    if (notesInput) {
      notesInput.addEventListener("input", () => {
        updateGiftField(giftIndex, 'notes', notesInput.value);
      });
    }
    
    // Card controls
    const upBtn = card.querySelector(".gift-up");
    if (upBtn) {
      upBtn.addEventListener("click", () => {
        moveGift(giftIndex, -1);
      });
    }
    
    const downBtn = card.querySelector(".gift-down");
    if (downBtn) {
      downBtn.addEventListener("click", () => {
        moveGift(giftIndex, 1);
      });
    }
    
    const dupBtn = card.querySelector(".gift-duplicate");
    if (dupBtn) {
      dupBtn.addEventListener("click", () => {
        duplicateGift(giftIndex);
      });
    }
    
    const removeBtn = card.querySelector(".gift-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        removeGift(giftIndex);
      });
    }
  });
}

function updateGiftField(index, field, value) {
  const intake = readIntake();
  const gifts = intake.SpecificGifts || [];
  if (index >= 0 && index < gifts.length) {
    gifts[index][field] = value;
    const updatedIntake = writeIntake({ SpecificGifts: [...gifts] });
    App.setState({ intake: updatedIntake });
    Bus.emit('preview-update');
  }
}

function moveGift(index, delta) {
  const intake = readIntake();
  const gifts = [...(intake.SpecificGifts || [])];
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= gifts.length) return;
  
  const [item] = gifts.splice(index, 1);
  gifts.splice(newIndex, 0, item);
  const updatedIntake = writeIntake({ SpecificGifts: gifts });
  App.setState({ intake: updatedIntake });
  renderTab('gifts');
  Bus.emit('preview-update');
}

function duplicateGift(index) {
  const intake = readIntake();
  const gifts = [...(intake.SpecificGifts || [])];
  if (index < 0 || index >= gifts.length) return;
  
  const copy = { ...gifts[index], id: `gift-${Date.now()}` };
  gifts.splice(index + 1, 0, copy);
  const updatedIntake = writeIntake({ SpecificGifts: gifts });
  App.setState({ intake: updatedIntake });
  renderTab('gifts');
  Bus.emit('preview-update');
}

function removeGift(index) {
  const intake = readIntake();
  const gifts = [...(intake.SpecificGifts || [])];
  if (index < 0 || index >= gifts.length) return;
  
  gifts.splice(index, 1);
  const updatedIntake = writeIntake({ SpecificGifts: gifts });
  App.setState({ intake: updatedIntake });
  renderTab('gifts');
  Bus.emit('preview-update');
}

// Name bank event handlers
function bindNameBankEvents() {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  
  tabContent.querySelectorAll(".namebank-add").forEach(btn => {
    btn.addEventListener("click", () => {
      addNameBankPerson(btn.dataset.role || "");
    });
  });

  const clientEditBtn = tabContent.querySelector(".client-edit");
  if (clientEditBtn) {
    clientEditBtn.addEventListener("click", () => {
      setActiveTab("testator");
    });
  }
  
  tabContent.querySelectorAll(".remove-person").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const intake = readIntake();
      const nameBank = [...(intake.NameBank || [])];
      nameBank.splice(idx, 1);
      const nextIntake = { ...intake, NameBank: nameBank };
      writeIntake({ NameBank: nameBank });
      syncChildrenCountWithNameBank(nextIntake, nameBank);
      debouncedRender();
      renderTab(currentArticle);
    });
  });

  tabContent.querySelectorAll(".person-save").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      updateNameBankEntry(idx, current => ({ ...current, viewMode: "summary" }), { reRender: true });
    });
  });

  tabContent.querySelectorAll(".person-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      updateNameBankEntry(idx, current => ({ ...current, viewMode: "edit" }), { reRender: true });
    });
  });

  tabContent.querySelectorAll(".person-input").forEach(input => {
    const eventName = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(eventName, () => {
      const idx = parseInt(input.dataset.idx);
      const field = input.dataset.field;
      let value = input.value;
      let resolvedDay = null;

      updateNameBankEntry(idx, current => {
        const next = { ...current };
        switch (field) {
          case "dobMonth": {
            next.dobMonth = value;
            const max = getDaysInMonth(value, next.dobYear);
            if (next.dobDay) {
              const dayNum = Math.min(Math.max(parseInt(next.dobDay, 10) || 1, 1), max);
              resolvedDay = String(dayNum);
              next.dobDay = resolvedDay;
            }
            break;
          }
          case "dobYear": {
            next.dobYear = value;
            const max = getDaysInMonth(next.dobMonth, value);
            if (next.dobDay) {
              const dayNum = Math.min(Math.max(parseInt(next.dobDay, 10) || 1, 1), max);
              resolvedDay = String(dayNum);
              next.dobDay = resolvedDay;
            }
            break;
          }
          case "dobDay": {
            value = value.replace(/[^0-9]/g, "");
            if (!value) {
              resolvedDay = "";
              next.dobDay = "";
              break;
            }
            let dayNum = parseInt(value, 10);
            if (Number.isNaN(dayNum) || dayNum < 1) dayNum = 1;
            const max = getDaysInMonth(next.dobMonth, next.dobYear);
            if (dayNum > max) dayNum = max;
            resolvedDay = String(dayNum);
            next.dobDay = resolvedDay;
            break;
          }
          default:
            next[field] = value;
            break;
        }
        return next;
      });

      if (field === "dobDay" && resolvedDay !== null) {
        input.value = resolvedDay;
      }

      if (field === "dobMonth" || field === "dobYear") {
        syncDobDayLimit(idx);
        if (resolvedDay !== null) {
          const dayInput = tabContent.querySelector(`.person-dob-day[data-idx="${idx}"]`);
          if (dayInput) dayInput.value = resolvedDay;
        }
      }

      if (field === "dobDay") {
        syncDobDayLimit(idx);
      }

      if (["first","middle","last","suffix"].includes(field)) {
        refreshPersonCardTitle(idx);
      }
    });
  });

  tabContent.querySelectorAll(".person-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const idx = parseInt(cb.dataset.idx);
      const field = cb.dataset.field;
      updateNameBankEntry(idx, current => ({ ...current, [field]: cb.checked }));
      refreshPersonCardTitle(idx);
    });
  });

  tabContent.querySelectorAll(".person-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const field = btn.dataset.field;
      const propertyMap = {
        middle: "middleEnabled",
        suffix: "suffixEnabled",
        address: "addressEnabled"
      };
      const property = propertyMap[field];
      if (!property) return;
      const isActive = !btn.classList.contains("active");
      updateNameBankEntry(idx, current => ({ ...current, [property]: isActive }), { reRender: true });
    });
  });

  tabContent.querySelectorAll(".person-primary-select").forEach(select => {
    select.addEventListener("change", () => {
      const idx = parseInt(select.dataset.idx);
      const nextPrimary = select.value;
      updateNameBankEntry(
        idx,
        current => {
          const badges = (current.roles || []).filter(role => !PRIMARY_NAME_ROLES.includes(role));
          return { ...current, primaryRole: nextPrimary, roles: [nextPrimary, ...badges] };
        },
        { reRender: true, syncChildren: true }
      );
    });
  });

  tabContent.querySelectorAll(".same-as-testator").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const intake = readIntake();
      const last = intake.ClientLastName || "";
      if (!last) {
        alert("Please enter the testator's last name in the Testator tab first.");
        return;
      }
      updateNameBankEntry(idx, current => ({ ...current, last }));
      const input = tabContent.querySelector(`.person-input[data-field="last"][data-idx="${idx}"]`);
      if (input) input.value = last;
      refreshPersonCardTitle(idx);
    });
  });

  tabContent.querySelectorAll(".person-address-same").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const intake = readIntake();
      const nextAddress = {
        addressEnabled: true,
        addressStreet1: intake.ClientStreet1 || "",
        addressStreet2: intake.ClientStreet2 || "",
        addressCity: intake.ClientCity || "",
        addressCounty: intake.DomicileCounty || "",
        addressState: intake.DomicileState || "New Jersey",
        addressZip: intake.ClientZip || ""
      };
      updateNameBankEntry(idx, current => ({ ...current, ...nextAddress }), { reRender: true });
    });
  });

  tabContent.querySelectorAll(".role-checks-inline input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const idx = parseInt(cb.dataset.idx);
      const role = cb.value;
      const checked = cb.checked;
      updateNameBankEntry(idx, current => {
        const badges = new Set(
          (current.roles || []).filter(value => !PRIMARY_NAME_ROLES.includes(value))
        );
        if (checked) {
          badges.add(role);
        } else {
          badges.delete(role);
        }
        return { ...current, roles: [getPrimaryRole(current), ...Array.from(badges)] };
      });
    });
  });

  tabContent.querySelectorAll(".person-child-parent").forEach(select => {
    select.addEventListener("change", () => {
      const idx = parseInt(select.dataset.idx);
      const value = select.value;
      const whichParent = select.dataset.parent === "B" ? "childParentBId" : "childParentAId";
      updateNameBankEntry(idx, current => ({ ...current, [whichParent]: value }), { reRender: true });
    });
  });

  tabContent.querySelectorAll(".add-co-parent").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      if (Number.isNaN(idx)) return;
      addCoParentForChild(idx);
    });
  });

  tabContent.querySelectorAll(".child-relationship-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const value = btn.dataset.value;
      updateNameBankEntry(
        idx,
        current => {
          const next = { ...current, childRelationship: value };
          if (value === "Biological") {
            next.childTreatAsBio = "Yes";
          } else if (!next.childTreatAsBio) {
            next.childTreatAsBio = "Yes";
          }
          if (value === "Step-child") {
            if (!next.childParentAId || next.childParentAId === CLIENT_PARENT_ID) {
              next.childParentAId = "";
            }
          } else {
            if (!next.childParentAId) {
              next.childParentAId = CLIENT_PARENT_ID;
            }
          }
          return next;
        },
        { reRender: true }
      );
    });
  });

  tabContent.querySelectorAll(".child-treatment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const value = btn.dataset.value;
      updateNameBankEntry(idx, current => ({ ...current, childTreatAsBio: value }), { reRender: true });
    });
  });

  tabContent.querySelectorAll(".person-card").forEach(card => {
    const idx = parseInt(card.dataset.idx);
    if (!Number.isNaN(idx)) {
      syncDobDayLimit(idx);
    }
  });
}

// Update helper for inline Name Bank editing
function updateNameBankEntry(idx, builder, options = {}) {
  const intake = readIntake();
  const nameBank = [...(intake.NameBank || [])];
  if (!nameBank[idx]) return;
  const current = nameBank[idx];
  const isCharity = current.entityType === "charity";
  
  // Normalize only person entities, not charities
  const normalizedCurrent = isCharity ? { ...current } : normalizeNameBankPerson({ ...current });
  const next = typeof builder === "function" ? builder(normalizedCurrent) : { ...normalizedCurrent, ...builder };
  const normalizedNext = isCharity ? next : normalizeNameBankPerson(next);
  
  nameBank[idx] = normalizedNext;
  writeIntake({ NameBank: nameBank });
  if (options.syncChildren) {
    syncChildrenCountWithNameBank({ ...intake, NameBank: nameBank }, nameBank);
  } else {
    App.setState({ intake: { ...App.state.intake, NameBank: nameBank } });
  }
  debouncedRender();
  if (options.reRender) {
    renderTab(currentArticle);
  }
}

function syncDobDayLimit(idx) {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  const monthSelect = tabContent.querySelector(`.person-dob-month[data-idx="${idx}"]`);
  const yearSelect = tabContent.querySelector(`.person-dob-year[data-idx="${idx}"]`);
  const dayInput = tabContent.querySelector(`.person-dob-day[data-idx="${idx}"]`);
  if (!dayInput) return;
  const month = monthSelect ? monthSelect.value : "";
  const year = yearSelect ? yearSelect.value : "";
  const max = getDaysInMonth(month, year);
  dayInput.max = max;
}

function refreshPersonCardTitle(idx) {
  const tabContent = document.getElementById("tabContent");
  if (!tabContent) return;
  const card = tabContent.querySelector(`.person-card[data-idx="${idx}"]`);
  if (!card) return;
  const titleEl = card.querySelector(".person-card-title");
  if (!titleEl) return;
  const intake = readIntake();
  const entity = (intake.NameBank || [])[idx];
  if (!entity) return;
  
  // Handle charity vs person names
  let name;
  if (entity.entityType === "charity") {
    name = entity.charityName || `Charity ${idx + 1}`;
    titleEl.textContent = `🏛️ ${name}`;
  } else {
    name = fullName(entity) || `Person ${idx + 1}`;
    titleEl.textContent = name;
  }
}

// Auto-scroll preview to active article
function scrollPreviewTo(anchorId) {
  // Use the preview-content container which is the scrollable element
  const previewContainer = document.getElementById('preview-content');
  const targetAnchor = previewContainer && previewContainer.querySelector(`#${anchorId}`);
  
  if (previewContainer && targetAnchor) {
    // Scroll the preview container to the anchor with more offset to show the article header
    previewContainer.scrollTop = targetAnchor.offsetTop - 40;
  }
}

// Tab switching
async function setActiveTab(key) {
  currentArticle = key;
  
  // Update state
  App.setState({ currentTab: key });
  
  // Update tab UI
  document.querySelectorAll(".tab").forEach(t => {
    const isActive = t.dataset.key === key;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-selected", isActive);
    t.setAttribute("tabindex", isActive ? "0" : "-1");
  });
  
  // Update page title
  const tabInfo = TABS.find(t => t.key === key);
  const titleEl = document.getElementById("currentTabTitle");
  if (titleEl && tabInfo) {
    titleEl.textContent = tabInfo.label;
  }
  
  // Render form and handle preview
  await renderTab(key);
  
  // Force preview to refresh immediately for tab-driven navigation
  Bus.emit('preview-update', { forceImmediate: true });

  // Emit tab change event (handled by event listeners)
  Bus.emit('tab-change', { 
    tab: key, 
    displayName: getTabDisplayName(key),
    intake: App.state.intake 
  });
  
  // Auto-scroll preview to the current article section
  // Wait a brief moment for preview to render
  setTimeout(() => {
    scrollPreviewTo(`article-${key}`);
  }, 150);
}

// Load clauses for current article
async function loadArticleClauses() {
  try {
    currentClauses = await getClauses({ product: "will", article: currentArticle });
  } catch (error) {
    console.warn(`No clauses found for article: ${currentArticle}`);
    currentClauses = [];
  }
  currentClauseIdx = 0;
  renderChips();
  debouncedRender();
}

// Render clause chips
function renderChips() {
  const chipRow = document.getElementById("chipRow");
  chipRow.innerHTML = currentClauses.map((c, idx) =>
    `<span class="chip ${idx === currentClauseIdx ? 'active' : ''}" data-idx="${idx}">${c.title}</span>`
  ).join("");
}

// Helper: Wrap [[TOKEN]] with .ph if not filled, .ph-filled if filled
function renderWithPlaceholders(text, fills) {
  return text.replace(/\[\[(.+?)\]\]/g, (_, key) => {
    const v = (fills && (key in fills) && String(fills[key]).trim()) || '';
    return v ? `<span class="ph-filled">${escapeHtml(v)}</span>`
             : `<span class="ph">[[${key}]]</span>`;
  });
}

// Render full preview with all articles (for bottom preview terminal view)
async function renderFullPreview() {
  if (!livePreview) return;
  
  const preview = document.getElementById("preview");
  preview.className = "clause preview-terminal"; // Add terminal styling
  
  const intake = readIntake();
  const tokens = deriveTokensFromIntake(intake);
  
  const order = TABS.filter(t => t.key !== "namebank" && t.key !== "signature").map(t => t.key);
  const parts = [];
  
  // Add main title
  parts.push(`<div class="h-title">LAST WILL AND TESTAMENT OF ${tokens.ClientFullName || '[[ClientFullName]]'}</div>`);
  
  for (const key of order) {
    try {
      const clauses = await getClauses({ product: "will", article: key });
      if (!clauses?.length) continue;
      
      const title = key.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());
      
      // Add article anchor and heading
      parts.push(`<span id="article-${key}" style="position:relative;"></span>`);
      parts.push(`<div class="h-article">ARTICLE — ${title.toUpperCase()}</div>`);
      
      for (const clause of clauses) {
        parts.push(`<div style="font-weight:600;margin:8px 0 4px;">${clause.title}</div>`);
        const hydratedText = hydrateBody(clause.body, tokens);
        const htmlWithPlaceholders = renderWithPlaceholders(hydratedText, tokens);
        parts.push(`<div style="margin-bottom:12px;">${htmlWithPlaceholders}</div>`);
      }
    } catch (error) {
      console.warn(`Failed to load clauses for ${key}:`, error);
    }
  }
  
  preview.innerHTML = parts.join("");
}

// Single clause preview (when chips are clicked)
function renderPreview() {
  if (!livePreview) return;
  
  const preview = document.getElementById("preview");
  preview.className = "clause preview-terminal"; // Add terminal styling
  
  if (!currentClauses.length) {
    // Show full document preview instead of single clause
    renderFullPreview();
    return;
  }
  
  const clause = currentClauses[currentClauseIdx] || currentClauses[0];
  const tokens = deriveTokensFromIntake(readIntake());
  
  // Get the raw clause body with tokens
  const hydratedText = hydrateBody(clause.body, tokens);
  
  // Apply placeholder highlighting
  const htmlWithPlaceholders = renderWithPlaceholders(hydratedText, tokens);
  
  // Add article anchor and clause title
  const articleAnchor = `<span id="article-${currentArticle}" style="position:relative;"></span>`;
  const clauseTitle = `<div class="h-article">${clause.title}</div>`;
  
  preview.innerHTML = articleAnchor + clauseTitle + htmlWithPlaceholders;
}// Full letter rendering (using same content as preview controller with 12pt Times New Roman styling)
async function renderFullLetter() {
  const letterPaper = document.getElementById("letterPaper");
  
  // Reset to default letter-paper styling
  letterPaper.className = "letter-paper";
  
  // Clear existing content first
  letterPaper.innerHTML = "";
  
  // Use the preview controller to get the properly filtered content
  if (previewController) {
    const intake = readIntake();
    const html = previewController.buildCompleteWill(intake);
    
    // Set the content (this will have the proper will-document structure with filtered content)
    letterPaper.innerHTML = html;
  } else {
    letterPaper.innerHTML = `<div class="h-title">LAST WILL AND TESTAMENT - Preview not available</div>`;
  }
}

async function renderTerminalLetter() {
  const letterPaper = document.getElementById("letterPaper");
  
  // Remove the default letter-paper class and add terminal class
  letterPaper.className = "terminal-mode";
  
  // Clear existing content first
  letterPaper.innerHTML = "";
  
  // Use the preview controller to get the same content as print preview
  if (previewController) {
    const intake = readIntake();
    const html = previewController.buildCompleteWill(intake);
    
    // Set the content (same as print preview, but styled with terminal mode CSS)
    letterPaper.innerHTML = html;
  } else {
    letterPaper.innerHTML = "Preview not available";
  }
}

// Map tab key to display name for preview controller
function getTabDisplayName(tabKey) {
  const mapping = {
    'testator': 'Testator',
    'namebank': 'Name Bank',
    'family': 'Family',
    'debts': 'Debts',
    'gifts': 'Gifts',
    'residuary': 'Residuary',
    'executors': 'Executors',
    'powers': 'Powers',
    'misc': 'Misc',
    'trusts': 'Trusts',
    'signature': 'Signature'
  };
  return mapping[tabKey] || 'Testator';
}

// Update preview with current intake data
function updatePreview(meta = {}) {
  if (!previewController) return;
  
  clearTimeout(debounceTimer);
  const delay = meta.forceImmediate ? 0 : 200;
  debounceTimer = setTimeout(() => {
    const intake = readIntake();
    previewController.renderAll(intake, meta);
  }, delay);
}

// Legacy function name for compatibility
function debouncedRender() {
  updatePreview();
}

// Hydrate form from localStorage
function hydrateFromStorage() {
  const intake = readIntake();
  Object.entries(intake).forEach(([key, value]) => {
    const el = document.getElementById(key);
    if (el && typeof value === "string") {
      el.value = value;
    }
  });
}

// Utility function
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
