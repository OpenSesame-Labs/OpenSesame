/** Shared shop credential fixture for capture-sync-evidence (test imports only). */
export const SHOP_PASSWORD = "a long unique passphrase for the shop";
// Pwned Passwords range prefix for SHOP_PASSWORD (SHA-1 k-anonymity); precomputed
// so evidence scripts never hash credential-class material at runtime.
export const SHOP_PWNED_RANGE_PREFIX = "D9623";
