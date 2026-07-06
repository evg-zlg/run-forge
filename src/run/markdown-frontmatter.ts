export interface Frontmatter {
  type: string;
  title: string;
  description: string;
  tags: string[];
  generated: true;
  [key: string]: string | string[] | boolean;
}

export function renderMarkdown(frontmatter: Frontmatter, body: string): string {
  return `---\n${renderYaml(frontmatter)}---\n\n${body.trim()}\n`;
}

export function hasFrontmatterWithType(content: string): boolean {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  return Boolean(match?.[1].match(/^type:\s*\S/m));
}

function renderYaml(frontmatter: Frontmatter): string {
  return Object.entries(frontmatter).map(([key, value]) => `${key}: ${renderYamlValue(value)}`).join("\n") + "\n";
}

function renderYamlValue(value: string | string[] | boolean): string {
  if (Array.isArray(value)) return `[${value.map((item) => yamlScalar(item)).join(", ")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return yamlScalar(value);
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 _./:-]*$/.test(value)) return value;
  return JSON.stringify(value);
}
