export {
  AUDIENCE_TEMPLATES,
  getAudienceTemplate,
  listAudienceTemplates,
} from "./catalog.js";

export {
  parseAudienceTemplate,
  parseAudienceTemplateCatalog,
} from "./parse.js";
export {
  AUDIENCE_TEMPLATE_IDS,
  type AudienceDefaults,
  type AudienceLimits,
  type AudienceTemplate,
  AudienceTemplateError,
  type AudienceTemplateId,
  type AudienceVocabulary,
  FORBIDDEN_TEMPLATE_KEYS,
  INHERITANCE_DEFAULTS,
  type InheritanceDefault,
  LIFETIME_KINDS,
  type LifetimeKindDefault,
  SUPPORT_CLAIM_STATUSES,
  type SupportClaim,
  type SupportClaimStatus,
  UNWIRED_PORTAL_SURFACES,
  USAGE_ACCOUNTING_MODES,
  type UnwiredPortalSurface,
  type UsageAccountingMode,
  includesId,
  isUnwiredPortalSurface,
} from "./types.js";
