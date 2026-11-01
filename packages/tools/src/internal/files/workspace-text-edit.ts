export function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

export function replaceFirst(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
}
