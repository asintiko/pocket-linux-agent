/**
 * The stub Windows lock screen. The person at the computer types a password into a picture of the real lock screen;
 * only the right one hides it and gives them the desktop. Underneath, Claude works on the real desktop, which the
 * window is excluded from in screenshots and interactive with only for injected input.
 */

/** The password the stub lock screen accepts until the owner sets another one. */
export const DEFAULT_PIN = '1805';
/** The word that lifts the picture without a password and without showing anything on screen. */
export const DEFAULT_ESCAPE = 'pocket';
export const MAX_ENTRIES = 12;

/** What the window shows: locked or not, and what to say under the password box. */
export interface LockView {
  locked: boolean;
  error: string;
  attempts: number;
}

export const WRONG_PIN = 'Неверный пароль. Попробуйте снова.';

/** A PIN of 4 to 12 digits: what a Windows pins fits and what the stub box accepts. */
export const validPin = (pin: string): boolean => /^\d{4,12}$/.test(pin);

/** The escape word: letters only, so it never collides with the digits the box draws. */
export const validEscape = (word: string): boolean => /^[a-z]{3,24}$/.test(word);

/**
 * The check itself. The window owns the typed text (it must draw the dots as the person types), the agent owns the
 * lock: what the box was submitted with decides whether the desktop is theirs.
 */
export class LockScreen {
  private locked: boolean;
  private error = '';
  private wrong = 0;
  /** On the owner's own laptop nothing but the password, the escape word and the CLI may lift the picture. */
  private ownerMode: boolean;

  constructor(
    private readonly readPin: () => string,
    private readonly log: (m: string) => void = () => {},
    ownerMode = true,
    locked = true,
    private readonly escape = DEFAULT_ESCAPE,
  ) {
    this.ownerMode = ownerMode;
    this.locked = locked;
  }

  setOwnerMode(on: boolean): void {
    this.ownerMode = on;
  }

  view(): LockView {
    return { locked: this.locked, error: this.error, attempts: this.wrong };
  }

  /** A submission from the password box. An empty one (Enter on an empty box) is not a guess. */
  submit(value: string): LockView {
    if (!this.locked) return this.view();
    if (!value) return this.view();
    const pin = this.readPin();
    if (pin.length > 0 && value === pin) {
      this.locked = false;
      this.error = '';
      this.wrong = 0;
      this.log('blocker: unlocked by password');
      return this.view();
    }
    this.wrong++;
    this.error = WRONG_PIN;
    this.log(`blocker: wrong password (${this.wrong})`);
    return this.view();
  }

  /** Back to the lock screen; the next person to sit down sees it again. */
  lock(): LockView {
    this.locked = true;
    this.error = '';
    return this.view();
  }

  /**
   * Letters typed at the picture and submitted with Enter: the owner's escape word lifts it, anything else is not a
   * guess at the password and changes nothing on screen.
   */
  submitWord(value: string): LockView {
    if (!this.locked || !value) return this.view();
    if (value.toLowerCase() !== this.escape.toLowerCase()) return this.view();
    this.locked = false;
    this.error = '';
    this.log('blocker: unlocked by the escape word');
    return this.view();
  }

  /**
   * The owner's way out when the phone is far away; the window only reports it, the agent decides. In owner mode
   * nothing here counts: no combination anyone at the laptop might know may lift the picture.
   */
  unlock(how: string, force = false): LockView {
    if (!this.locked) return this.view();
    if (this.ownerMode && !force) {
      this.log(`blocker: ${how} ignored (owner mode: password, escape word or the CLI only)`);
      return this.view();
    }
    this.locked = false;
    this.error = '';
    this.log(`blocker: unlocked without the password (${how})`);
    return this.view();
  }
}
