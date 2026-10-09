import { describe, expect, it } from 'vitest';
import { escapeCell, toCSV } from './csv';

describe('escapeCell', () => {
  it('leaves normal cells untouched', () => {
    expect(escapeCell('Olivia Bennett')).toBe('Olivia Bennett');
    expect(escapeCell(48)).toBe('48');
    expect(escapeCell(null)).toBe('');
    expect(escapeCell(undefined)).toBe('');
  });

  it('quotes cells with commas, quotes or newlines', () => {
    expect(escapeCell('a,b')).toBe('"a,b"');
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises =-prefixed cells', () => {
    expect(escapeCell('=1+1')).toBe("'=1+1");
    expect(escapeCell('=cmd|/c calc')).toBe("'=cmd|/c calc");
  });

  it('neutralises +-prefixed cells', () => {
    expect(escapeCell('+1+1')).toBe("'+1+1");
  });

  it('neutralises @-prefixed cells', () => {
    expect(escapeCell('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
  });

  it('neutralises --prefixed cells', () => {
    expect(escapeCell('-2+3')).toBe("'-2+3");
  });

  it('quotes neutralised cells that also need quoting', () => {
    expect(escapeCell('=1,"2"')).toBe("\"'=1,\"\"2\"\"\"");
  });
});

describe('toCSV', () => {
  it('builds a header + rows document', () => {
    expect(toCSV([{ a: 'x', b: 'y' }, { a: 'p', b: 'q' }])).toBe('a,b\nx,y\np,q');
  });

  it('neutralises formula cells inside rows', () => {
    expect(toCSV([{ name: '=2+2', total: 5 }])).toBe("name,total\n'=2+2,5");
  });
});
