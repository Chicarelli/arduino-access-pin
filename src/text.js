/** Max length of `mensagem` (fits a 16x2 LCD). */
export const MAX_MESSAGE_LENGTH = 32;

/** "João Ção" -> "Joao Cao": strips accents and drops anything that is not printable ASCII. */
export function toAscii(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Bem-vindo, <first name>!" in plain ASCII, never longer than MAX_MESSAGE_LENGTH. */
export function welcomeMessage(nome) {
  const firstName = toAscii(nome).split(' ')[0];
  if (!firstName) return 'Bem-vindo!';
  const room = MAX_MESSAGE_LENGTH - 'Bem-vindo, !'.length;
  return `Bem-vindo, ${firstName.slice(0, room)}!`;
}
