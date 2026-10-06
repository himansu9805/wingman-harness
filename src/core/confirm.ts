type Confirmer = (question: string) => Promise<boolean>;

let confirmer: Confirmer | null = null;

/**
 * Installs the function tools use to ask the user a yes/no question.
 *
 * @param fn The confirmer, or `null` to deny every request.
 */
export function setConfirmer(fn: Confirmer | null) {
  confirmer = fn;
}

/**
 * Asks the user to approve an action. Denies when nobody can answer
 * (no terminal attached).
 *
 * @param question The question to show the user.
 * @returns Whether the user approved.
 */
export function confirm(question: string): Promise<boolean> {
  return confirmer ? confirmer(question) : Promise.resolve(false);
}
