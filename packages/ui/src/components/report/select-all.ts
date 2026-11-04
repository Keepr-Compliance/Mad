// Pure helper (BACKLOG-3502a): no directive and no React, so a Server Component can call it.
// Generic since BACKLOG-4032 slice 4a: Dropdown mode="multi" calls it with its own value type.
/** Every option value selected, keeping anything already selected, no duplicates. */
export function selectAllValues<V extends string = string>(
  options: readonly { value: V }[],
  selected: readonly V[]
): V[] {
  const out = [...selected];
  for (const option of options) {
    if (!out.includes(option.value)) out.push(option.value);
  }
  return out;
}
