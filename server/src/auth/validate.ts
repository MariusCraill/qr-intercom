/** Input validation shared by the resident register/update routes. */

/**
 * Password policy. Deliberately modest: length is what actually matters, and
 * an over-strict policy mostly pushes people toward reuse and written-down
 * passwords. Rejects the obvious filler rather than trying to be clever.
 */
const WEAK = new Set([
  "password", "password1", "password123", "123456", "12345678", "123456789",
  "1234567890", "qwerty", "qwertyuiop", "letmein", "welcome", "admin",
  "abc123", "iloveyou", "monkey", "dragon", "sunshine", "princess",
  "football", "baseball", "trustno1", "passw0rd", "111111", "000000",
]);

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) {
    return "Password required";
  }
  if (password.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (password.length > 200) {
    return "Password must be under 200 characters";
  }
  if (WEAK.has(password.toLowerCase())) {
    return "That password is too common. Choose something harder to guess.";
  }
  return null;
}

export function isValidEmail(email: unknown): boolean {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)
  );
}
