export interface PlaceholderRewriteOptions {
  readonly offset?: number;
  readonly sqlite?: boolean;
}

export function rewritePlaceholders(
  text: string,
  values: readonly unknown[],
  options: PlaceholderRewriteOptions,
): { readonly text: string; readonly values: readonly unknown[] } {
  const rewrittenValues: unknown[] = [];
  let output = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  let dollarQuote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  while (index < text.length) {
    if (lineComment) {
      const character = text[index++]!;
      output += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (text.startsWith("*/", index)) {
        output += "*/";
        index += 2;
        blockComment = false;
      } else output += text[index++]!;
      continue;
    }
    if (dollarQuote) {
      if (text.startsWith(dollarQuote, index)) {
        output += dollarQuote;
        index += dollarQuote.length;
        dollarQuote = null;
      } else output += text[index++]!;
      continue;
    }
    if (quote) {
      const character = text[index++]!;
      output += character;
      if (character === quote) {
        if (text[index] === quote) output += text[index++]!;
        else quote = null;
      }
      continue;
    }
    if (text.startsWith("--", index)) {
      output += "--";
      index += 2;
      lineComment = true;
      continue;
    }
    if (text.startsWith("/*", index)) {
      output += "/*";
      index += 2;
      blockComment = true;
      continue;
    }
    if (options.sqlite && text.startsWith('"public".', index)) {
      index += 9;
      continue;
    }
    const character = text[index]!;
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const placeholder = text.slice(index).match(/^\$(\d+)/);
      if (placeholder) {
        const position = Number(placeholder[1]);
        if (position < 1 || position > values.length) {
          throw new Error(`SQL placeholder $${position} has no matching value.`);
        }
        if (options.sqlite) {
          output += "?";
          rewrittenValues.push(values[position - 1]);
        } else {
          output += `$${position + (options.offset ?? 0)}`;
        }
        index += placeholder[0].length;
        continue;
      }
      const delimiter = text.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        dollarQuote = delimiter;
        output += delimiter;
        index += delimiter.length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return { text: output, values: options.sqlite ? rewrittenValues : values };
}

export function sqliteSql(text: string): string {
  return rewritePlaceholders(text, [], { sqlite: true }).text;
}

/** Masks quoted values, identifiers, and comments while retaining SQL keywords. */
export function sqlStructure(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("--", index)) {
      const end = text.indexOf("\n", index + 2);
      const length = (end < 0 ? text.length : end) - index;
      output += " ".repeat(length);
      index += length;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      const length = (end < 0 ? text.length : end + 2) - index;
      output += " ".repeat(length);
      index += length;
      continue;
    }
    const character = text[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      output += " ";
      index += 1;
      while (index < text.length) {
        output += " ";
        if (text[index] === quote) {
          index += 1;
          if (text[index] === quote) {
            output += " ";
            index += 1;
            continue;
          }
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "$") {
      const delimiter = text.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        const end = text.indexOf(delimiter, index + delimiter.length);
        const length = (end < 0 ? text.length : end + delimiter.length) - index;
        output += " ".repeat(length);
        index += length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}
