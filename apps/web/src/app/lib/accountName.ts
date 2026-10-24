// The same rule as the backend's ACCOUNT_NAME (packages/squad/src/accounts/store.ts). The server
// checks again; this only gives a fast, plain answer in the form.
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function accountNameError(name: string): string | undefined {
  if (name === "") return "Enter a name.";
  if (!ACCOUNT_NAME.test(name)) return "The name needs lower-case letters, digits, dot, dash or underscore, and must start with a letter or digit.";
  return undefined;
}

/** A name from the signed-in email: the part before @, lower case, other characters as dashes. */
export function suggestName(email: string | undefined): string {
  const local = (email ?? "").split("@")[0] ?? "";
  return local.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "").replace(/-+$/, "");
}
