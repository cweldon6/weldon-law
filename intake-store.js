// Centralized intake state + derived tokens, incl. Name Bank helpers.
import { getDefaultState } from "../shared/tokens.js";

const CLIENT_PARENT_ID = "__CLIENT__";

const KEY = "intakeState";
export function readIntake(){ try{ return JSON.parse(localStorage.getItem(KEY) || "{}"); }catch{ return {}; } }
export function writeIntake(patch){
  const curr = readIntake();
  const next = { ...curr, ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
export function onInputBind(el){
  const id = el.id;
  el.addEventListener("input", ()=>writeIntake({ [id]: el.value }));
}

function formatMiddleInitial(value) {
  const text = (value || "").trim();
  if (!text) return "";
  const firstChar = text.charAt(0).toUpperCase();
  return `${firstChar}.`;
}

// Derived token builders (assemble separate fields to [[Tokens]])
export function deriveTokensFromIntake(intake){
  const defaults = getDefaultState();
  const pick = (v, fallback="") => (v ?? fallback);
  
  // Helper to get person name by role and index, or field value, or fallback
  const getPersonName = (fieldName, role, index = 0, fallback = "") => {
    const fieldValue = pick(intake[fieldName]);
    if (fieldValue && fieldValue !== "— Select —") {
      return fieldValue;
    }
    const people = listPeopleByRole(intake, role);
    return people[index] ? fullName(people[index]) : fallback;
  };

  // Build client full name from components
  const first = pick(intake.ClientFirstName);
  const includeMiddle = intake.ClientMiddleToggle === true;
  const includeSuffix = intake.ClientSuffixToggle === true;
  const middleInitialOnly = intake.ClientMiddleInitialOnly === true;
  const middleRaw = pick(intake.ClientMiddleName);
  const middleApplied = includeMiddle ? middleRaw : "";
  const middleForFullName = includeMiddle ? (middleInitialOnly ? formatMiddleInitial(middleRaw) : middleRaw) : "";
  const last = pick(intake.ClientLastName);
  const suffixRaw = pick(intake.ClientSuffix);
  const suffixForFullName = includeSuffix ? suffixRaw : "";
  const full = [first, middleForFullName, last, suffixForFullName].filter(Boolean).join(" ");

  // Build address inline - full address with street and ZIP for expanded mode
  const street1 = pick(intake.ClientStreet1);
  const street2 = pick(intake.ClientStreet2);
  const city = pick(intake.ClientCity);
  const county = pick(intake.DomicileCounty);
  const state = pick(intake.DomicileState);
  const zip = pick(intake.ClientZip);
  const idModeRaw = pick(intake.IdMode, "Simple");
  const idMode = idModeRaw.toLowerCase();
  
  const addrParts = [street1, street2, city].filter(Boolean);
  const addrInline = addrParts.join(", ");

  // Get people from name bank for roles
  const nameBank = Array.isArray(intake.NameBank) ? intake.NameBank : [];
  const byId = new Map(nameBank.map(person => [person.id, person]));
  const spouseList = listPeopleByRole(intake, "Spouse");
  const partnerList = listPeopleByRole(intake, "Partner");
  const formerSpouseList = listPeopleByRole(intake, "Former Spouse");
  const childrenList = listPeopleByRole(intake, "Child");
  const disinheritedList = listPeopleByRole(intake, "Disinherited");

  const getRelationship = (child = {}) => (child.childRelationship || "").toLowerCase();
  const isStepChild = child => getRelationship(child) === "step-child";
  const isAdoptedChild = child => getRelationship(child) === "adopted";
  const isArtChild = child => getRelationship(child) === "conceived with art";

  const stepChildren = childrenList.filter(isStepChild);
  const adoptedChildren = childrenList.filter(isAdoptedChild);
  const artChildren = childrenList.filter(isArtChild);
  const clientChildren = childrenList.filter(child => !isStepChild(child));

  const toNames = (records = []) => records
    .map(fullName)
    .map(name => name.trim())
    .filter(Boolean);

  const toInlineList = (records = []) => toNames(records).join(", ");

  const toInlineListWithAnd = (records = []) => {
    const names = toNames(records);
    if (names.length === 0) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    const head = names.slice(0, -1).join(", ");
    return `${head}, and ${names[names.length - 1]}`;
  };

  const toBulletList = (records = []) => {
    const names = toNames(records);
    return names.length ? `\n${names.map(name => `- ${name}`).join("\n")}` : "";
  };

  const spouseRecord = spouseList[0] || null;
  const partnerRecord = partnerList[0] || null;
  const formerSpouseRecord = formerSpouseList[0] || null;
  const spouseId = spouseRecord?.id || "";

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

  const otherParentIds = new Set();
  priorChildren.forEach(child => {
    const parentA = child.childParentAId;
    const parentB = child.childParentBId;
    const otherParentId = parentA === CLIENT_PARENT_ID ? parentB : parentA;
    if (otherParentId && otherParentId !== CLIENT_PARENT_ID) {
      otherParentIds.add(otherParentId);
    }
  });

  const otherParentNames = Array.from(otherParentIds)
    .map(id => {
      const record = byId.get(id);
      const name = record ? fullName(record) : "";
      return name && name.trim() ? name.trim() : "Unknown parent";
    })
    .filter(Boolean);

  const formatOtherParentNames = () => {
    if (!otherParentNames.length) return "";
    if (otherParentNames.length === 1) {
      return ` (with ${otherParentNames[0]})`;
    }
    const names = [...otherParentNames];
    const last = names.pop();
    return ` (with ${names.join(", ")}, and ${last})`;
  };
  
  // Build derived values
  const spouseName = spouseRecord ? fullName(spouseRecord) : "my spouse";
  const partnerName = partnerRecord ? fullName(partnerRecord) : "";
  const formerSpouseName = formerSpouseRecord ? fullName(formerSpouseRecord) : "";
  const childrenText = clientChildren.length > 0 ? 
    toInlineListWithAnd(clientChildren) : 
    "my children";
  const childrenListInline = toInlineListWithAnd(clientChildren);
  const childrenBulletList = toBulletList(clientChildren);
  const stepChildrenInline = toInlineList(stepChildren);
  const stepChildrenBullet = toBulletList(stepChildren);
  const adoptedChildrenBullet = toBulletList(adoptedChildren);
  const priorChildrenBullet = toBulletList(priorChildren);
  const artChildrenBullet = toBulletList(artChildren);
  const selectedChildrenList = (artChildren.length > 0 && artChildren.length === clientChildren.length)
    ? artChildrenBullet
    : childrenBulletList;
  const currentChildrenBullet = toBulletList(currentSpouseChildren);

  const relationshipStatusRaw = pick(intake.RelationshipStatus, defaults.RelationshipStatusDescriptor);
  const relationshipStatusDescriptor = (relationshipStatusRaw || "").toString().trim().toLowerCase() || defaults.RelationshipStatusDescriptor;
  const spousePartnerTerm = spouseRecord ? "spouse" : (partnerRecord ? "partner" : defaults.SpousePartnerTerm);
  const spousePartnerFullName = spouseRecord ? spouseName : (partnerName || defaults.SpousePartnerFullName);

  return {
    ...defaults,
    ...intake,
    ClientMiddleName: middleApplied,
    ClientMiddleNameFormatted: middleForFullName,
    ClientSuffix: suffixForFullName,
    // Core identity
    ClientFullName: full || defaults.ClientFullName,
    TestatorFullName: full || defaults.ClientFullName, // Same as client
    ClientAddressInline: addrInline || defaults.ClientAddressInline,
    ClientCity: city || defaults.ClientCity,
    City: city || defaults.City,
    DomicileCounty: county || defaults.DomicileCounty,
    County: county || defaults.County,
    DomicileState: state || defaults.DomicileState,
    State: state || defaults.State,
    ClientZip: zip || defaults.ClientZip,
    ZipCode: zip || defaults.ZipCode,
    idMode,

    // Family
    SpouseFullName: spouseName,
    PartnerFullName: partnerName || pick(intake.PartnerFullName, defaults.PartnerFullName),
    FormerSpouseFullName: formerSpouseName || pick(intake.FormerSpouseFullName, defaults.FormerSpouseFullName),
    ChildrenList: selectedChildrenList || childrenText,
    ChildrenListInline: childrenListInline || childrenText,
    StepchildrenList: stepChildrenBullet,
    StepchildrenListInline: stepChildrenInline,
    PriorChildrenList: priorChildrenBullet,
    OtherParentNamesList: formatOtherParentNames(),
    AdoptedChildrenList: adoptedChildrenBullet,
  CurrentChildrenList: currentChildrenBullet || selectedChildrenList,
    GuardianName: getPersonName("GuardianName", "Guardian", 0, defaults.GuardianName),
    DisinheritedPersonName: disinheritedList.length > 0 ? fullName(disinheritedList[0]) : "None",
  RelationshipStatusDescriptor: relationshipStatusDescriptor,
  SpousePartnerTerm: spousePartnerTerm,
  SpousePartnerFullName: spousePartnerFullName,
    
    // Charities
    CharityName: (() => {
      const charityId = pick(intake.ResiduaryCharity, "");
      if (!charityId) return "[[CharityName]]";
      const charity = byId.get(charityId);
      return charity ? (charity.charityName || "Unnamed Charity") : "[[CharityName]]";
    })(),
    BackupCharitiesList: (() => {
      const backupCharities = Array.isArray(intake.BackupCharities) ? intake.BackupCharities : [];
      if (backupCharities.length === 0) return "[[BackupCharitiesList]]";
      
      // Format percentage display based on number of charities
      const formatPercentage = (percentStr, totalCharities) => {
        const percent = parseFloat(percentStr) || 0;
        
        // 1 charity: 100%
        if (totalCharities === 1) {
          return "(100%)";
        }
        
        // 2 charities: 50%
        if (totalCharities === 2) {
          return "(50%)";
        }
        
        // 3 charities: use fraction
        if (totalCharities === 3) {
          return "(1/3)";
        }
        
        // 4 charities: 25%
        if (totalCharities === 4) {
          return "(25%)";
        }
        
        // 5 charities: 20%
        if (totalCharities === 5) {
          return "(20%)";
        }
        
        // 6+ charities: show actual percentage rounded to 2 decimal places
        return `(${percent.toFixed(2)}%)`;
      };
      
      const items = backupCharities
        .map(entry => {
          // Show placeholder for unselected charities to indicate incomplete entry
          if (!entry.charityId) {
            const percentDisplay = entry.percentage ? ` ${formatPercentage(entry.percentage, backupCharities.length)}` : "";
            return `[SELECT CHARITY]${percentDisplay}`;
          }
          const charity = byId.get(entry.charityId);
          const name = charity ? (charity.charityName || "Unnamed Charity") : "Unknown Charity";
          const percentDisplay = entry.percentage ? ` ${formatPercentage(entry.percentage, backupCharities.length)}` : "";
          return `${name}${percentDisplay}`;
        });
      return items.length ? items.join("; ") : "[[BackupCharitiesList]]";
    })(),
    
    // Alternate Beneficiaries (includes "in equal shares" for 2+)
    AlternateBeneficiaries: (() => {
      const alternateBeneficiaries = Array.isArray(intake.AlternateBeneficiaries) ? intake.AlternateBeneficiaries : [];
      if (alternateBeneficiaries.length === 0) return "[[AlternateBeneficiaries]]";
      
      const names = alternateBeneficiaries
        .map(entry => {
          if (!entry.personId) return null;
          const person = byId.get(entry.personId);
          if (!person) return null;
          return fullName(person) || "Unnamed Person";
        })
        .filter(Boolean);
      
      if (names.length === 0) return "[[AlternateBeneficiaries]]";
      
      // Format based on count
      if (names.length === 1) {
        // Single beneficiary: just the name
        return names[0];
      } else {
        // Multiple beneficiaries: names + "in equal shares"
        const lastPerson = names[names.length - 1];
        const otherPeople = names.slice(0, -1);
        return `${otherPeople.join(', ')} & ${lastPerson}, in equal shares`;
      }
    })(),
    
    // Alternate shares clause (deprecated - logic moved into AlternateBeneficiaries)
    AlternateSharesClause: (() => {
      return "";
    })(),
    
    // Executors (use Name Bank selections or form values)
    PrimaryExecutorName: getPersonName("PrimaryExecutor", "Executor", 0, spouseName),
    AlternateExecutorName: getPersonName("AlternateExecutor", "Executor", 1, childrenText),
    
    // Build individual alternate executor tokens for fixed placeholder approach
    ExecutorAlternate1: (() => {
      const alternateExecutors = Array.isArray(intake.AlternateExecutors) 
        ? intake.AlternateExecutors 
        : [];
      
      if (alternateExecutors.length === 0) return "";
      
      const first = alternateExecutors[0];
      if (!first?.personId) return "";
      
      const person = byId.get(first.personId);
      return person ? (fullName(person) || "Unnamed Person") : "";
    })(),
    
    ExecutorAlternate1Clause: (() => {
      const alternateExecutors = Array.isArray(intake.AlternateExecutors) 
        ? intake.AlternateExecutors 
        : [];
      
      if (alternateExecutors.length === 0) return "\u200B"; // zero-width space to prevent [[placeholder]] showing
      
      const first = alternateExecutors[0];
      if (!first?.personId) return "\u200B";
      
      const person = byId.get(first.personId);
      const name = person ? (fullName(person) || "Unnamed Person") : "";
      if (!name) return "\u200B";
      
      const primaryName = getPersonName("PrimaryExecutor", "Executor", 0, spouseName);
      return `\n\nIf ${primaryName} does not qualify or ceases to serve, I nominate ${name} to serve as Executor of this Will.`;
    })(),
    
    ExecutorAlternateListClause: (() => {
      const alternateExecutors = Array.isArray(intake.AlternateExecutors) 
        ? intake.AlternateExecutors 
        : [];
      
      // Only show if we have 2+ alternates
      if (alternateExecutors.length < 2) return "\u200B"; // zero-width space to prevent [[placeholder]] showing
      
      // Get names from index 1 onward (skip first alternate)
      const names = alternateExecutors.slice(1)
        .map(entry => {
          if (!entry.personId) return null;
          const person = byId.get(entry.personId);
          if (!person) return null;
          return fullName(person) || "Unnamed Person";
        })
        .filter(Boolean);
      
      if (names.length === 0) return "\u200B";
      
      const primaryName = getPersonName("PrimaryExecutor", "Executor", 0, spouseName);
      const firstAlt = (() => {
        const first = alternateExecutors[0];
        if (!first?.personId) return "";
        const person = byId.get(first.personId);
        return person ? (fullName(person) || "Unnamed Person") : "";
      })();
      
      if (!firstAlt) return "\u200B";
      
      const alternatesList = names.join(", then ");
      return `\n\nIf neither ${primaryName} nor ${firstAlt} qualify or cease to serve, I nominate ${alternatesList} to serve in the order named.`;
    })(),
    
    // Corporate fiduciary
    CorporateFiduciaryName: (() => {
      const corpId = intake.CorporateFiduciaryName;
      if (!corpId) return "[[CorporateFiduciaryName]]";
      const corp = byId.get(corpId);
      if (!corp) return "[[CorporateFiduciaryName]]";
      // Corporate fiduciaries store name in charityName field
      return corp.charityName || corp.first || "Unnamed Corporate Fiduciary";
    })(),
    
    // Guardianship
    MinorGuardianPrimaryName: getPersonName("MinorGuardianPrimary", "Guardian", 0, ""),
    MinorGuardianAlternateName: getPersonName("MinorGuardianAlternate", "Guardian", 1, ""),
    UTMACustodianName: getPersonName("UTMACustodian", "Trustee", 0, ""),
    PetCaretakerName: getPersonName("PetCaretaker", "Other", 0, ""),

    // Trust placeholder support
    MinorTrustAge: (() => {
      const raw = intake.MinorTrustAge;
      if (raw !== undefined && raw !== null && raw !== "") return raw;
      return defaults.MinorTrustAge;
    })(),
    Age1: (() => {
      const raw = intake.Age1;
      if (raw !== undefined && raw !== null && raw !== "") return raw;
      return defaults.Age1;
    })(),
    Age2: (() => {
      const raw = intake.Age2;
      if (raw !== undefined && raw !== null && raw !== "") return raw;
      return defaults.Age2;
    })(),
    Age3: (() => {
      const raw = intake.Age3;
      if (raw !== undefined && raw !== null && raw !== "") return raw;
      return defaults.Age3;
    })(),
    EducationAge: (() => {
      const raw = intake.EducationAge;
      if (raw !== undefined && raw !== null && raw !== "") return raw;
      return defaults.EducationAge;
    })(),
    DollarThreshold: (() => {
      const rawValue = pick(intake.DollarThreshold);
      const raw = typeof rawValue === 'number' ? String(rawValue) : String(rawValue || '').trim();
      if (raw) return raw.startsWith("$") ? raw : `$${raw}`;
      return defaults.DollarThreshold;
    })(),
    DollarAmount: (() => {
      const rawValue = pick(intake.DollarAmount);
      const raw = typeof rawValue === 'number' ? String(rawValue) : String(rawValue || '').trim();
      if (raw) return raw.startsWith("$") ? raw : `$${raw}`;
      return defaults.DollarAmount;
    })(),
    TrusteeName: (() => {
      const manualValue = pick(intake.TrusteeNameManual) || pick(intake.TrusteeName);
      const manual = typeof manualValue === 'string' ? manualValue.trim() : manualValue;
      if (manual) return manual;
      const selectedId = pick(intake.TrusteeNameSelection);
      if (selectedId) {
        const person = byId.get(selectedId);
        if (person) {
          const name = fullName(person);
          if (name) return name;
        }
      }
      const trustees = listPeopleByRole(intake, "Trustee");
      if (trustees.length) {
        const name = fullName(trustees[0]);
        if (name) return name;
      }
      return defaults.TrusteeName;
    })(),
    AlternateTrusteeList: (() => {
      const manualValue = pick(intake.AlternateTrusteeListOverride);
      const manual = typeof manualValue === 'string' ? manualValue.trim() : manualValue;
      if (manual) return manual;
      const selected = Array.isArray(intake.AlternateTrusteeList)
        ? intake.AlternateTrusteeList.filter(Boolean)
        : [];
      if (selected.length) return selected.join(", ");
      const trustees = listPeopleByRole(intake, "Trustee")
        .slice(1)
        .map(person => fullName(person))
        .filter(Boolean);
      if (trustees.length) return trustees.join(", ");
      return defaults.AlternateTrusteeList;
    })(),
    RemainderBeneficiary: (() => {
      const manualValue = pick(intake.RemainderBeneficiaryManual) || pick(intake.RemainderBeneficiary);
      const manual = typeof manualValue === 'string' ? manualValue.trim() : manualValue;
      if (manual) return manual;
      const remainderId = pick(intake.RemainderBeneficiarySelection);
      if (remainderId) {
        const record = byId.get(remainderId);
        if (record) {
          const name = record.entityType === 'charity'
            ? (record.charityName || '')
            : fullName(record);
          if (name) return name;
        }
      }
      const residuaryFallback = pick(intake.ResiduaryCharity, "");
      if (residuaryFallback && byId.has(residuaryFallback)) {
        const charity = byId.get(residuaryFallback);
        const name = charity?.charityName || "";
        if (name) return name;
      }
      return defaults.RemainderBeneficiary;
    })(),
    AlternateGuardianList: (() => {
      const manualValue = pick(intake.AlternateGuardianListOverride);
      const manual = typeof manualValue === 'string' ? manualValue.trim() : manualValue;
      if (manual) return manual;
      const selected = Array.isArray(intake.AlternateGuardianList)
        ? intake.AlternateGuardianList.filter(Boolean)
        : [];
      if (selected.length) return selected.join(", ");
      const guardians = listPeopleByRole(intake, "Guardian")
        .slice(1)
        .map(person => fullName(person))
        .filter(Boolean);
      if (guardians.length) return guardians.join(", ");
      return defaults.AlternateGuardianList;
    })(),
    
    // Trustees
    SuccessorTrusteeName: getPersonName("SuccessorTrustee", "Trustee", 0, "Corporate Trustee LLC"),
    
    // Beneficiaries
    PrimaryBeneficiaryName: getPersonName("PrimaryBeneficiary", "Beneficiary", 0, spouseName),
    ContingentBeneficiaryName: getPersonName("ContingentBeneficiary", "Beneficiary", 1, childrenText),
    UltimateBeneficiary: getPersonName("UltimateBeneficiary", "Beneficiary", 2, "United Way"),
    DefaultTangibleBeneficiary: getPersonName("DefaultTangibleBeneficiary", "Beneficiary", 0, spouseName),
    PersonalEffectsBeneficiaries: getPersonName("PersonalEffectsBeneficiaries", "Beneficiary", 0, childrenText),
    DigitalAssetsBeneficiary: getPersonName("DigitalAssetsBeneficiary", "Beneficiary", 0, spouseName),
    BeneficiaryName: getPersonName("GiftBeneficiary", "Beneficiary", 0, ""),
    
    // Witnesses
    WitnessOneName: getPersonName("WitnessOne", "Witness", 0, "Witness One"),
    WitnessTwoName: getPersonName("WitnessTwo", "Witness", 1, "Witness Two"),
    
    // Administrative - use form values or derive from domicile
    CountyForProbate: pick(intake.CountyForProbate, intake.DomicileCounty),
    GoverningState: pick(intake.GoverningState, intake.DomicileState),
    VenueCounty: (() => {
      const explicit = pick(intake.VenueCounty);
      if (explicit) return explicit;
      const probateCounty = pick(intake.CountyForProbate, county);
      if (probateCounty) return probateCounty;
      return defaults.VenueCounty || county || defaults.DomicileCounty;
    })(),
    VenueState: (() => {
      const explicit = pick(intake.VenueState);
      if (explicit) return explicit;
      const governing = pick(intake.GoverningState, state);
      if (governing) return governing;
      return defaults.VenueState || state || defaults.DomicileState;
    })(),
  };
}

// Name Bank structure in intakeState:
// intakeState.NameBank = [{ id, first, middle, last, suffix, roles:["Spouse","Child","Executor",...]}]
export function listPeopleByRole(intake, role){
  const bank = Array.isArray(intake.NameBank) ? intake.NameBank : [];
  return bank.filter(p => (p.roles||[]).includes(role));
}
export function fullName(p){
  if (!p) return "";
  const first = (p.first || "").trim();
  const includeMiddle = p.middleEnabled === undefined ? Boolean(p.middle) : p.middleEnabled === true;
  const middleRaw = (p.middle || "").trim();
  let middleSegment = "";
  if (includeMiddle && middleRaw) {
    if (p.middleInitialOnly) {
      middleSegment = `${middleRaw.charAt(0).toUpperCase()}.`;
    } else {
      middleSegment = middleRaw;
    }
  }
  const last = (p.last || "").trim();
  const includeSuffix = p.suffixEnabled === undefined ? Boolean(p.suffix) : p.suffixEnabled === true;
  const suffix = includeSuffix ? (p.suffix || "").trim() : "";
  return [first, middleSegment, last, suffix].filter(Boolean).join(" ");
}