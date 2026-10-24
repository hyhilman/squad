// A pass runs a pinned model. A floating alias would change what runs without a squad change, and
// it would make the usage records mean different things over time.

const FLOATING: ReadonlySet<string> = new Set(["latest", "default", "opus", "sonnet", "haiku", "best"]);

export function checkModel(model: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(model) || FLOATING.has(model)) throw new Error(`model ${JSON.stringify(model)} is not a pinned model id`);
  return model;
}

export function checkSkillName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`skill name ${JSON.stringify(name)} is not safe`);
  return name;
}
