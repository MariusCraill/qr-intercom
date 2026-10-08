/**
 * Phone number matching, shared by resident and admin login.
 *
 * Phone is the primary login identifier for a resident and, with this change,
 * for an admin too. That means it gets typed by hand off a keypad, and
 * "+65 9001 0001", "6590010001" and "+65-9001-0001" all have to reach the same
 * account. Matching on the stored string made that depend on punctuation the
 * resident does not control.
 *
 * Storage is a normalised `phone_norm` column (digits only) carrying a UNIQUE
 * index. That index is what actually makes "one number, one account" true:
 * the pre-existing UNIQUE on the formatted `phone` column only stopped two
 * people typing the *same* string, so `+65 9001 0001` and `6590010001` were
 * two accounts for one phone.
 */

/** Everything that is not a digit is punctuation or a country-code prefix. */
export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\D+/g, "");
}

/**
 * The stored forms a typed number is allowed to match.
 *
 * The North American country code is handled here rather than inside
 * normalizePhone() on purpose. Folding a leading "1" away during
 * normalisation would let a genuine 11-digit number silently collide with a
 * 10-digit one, which is a data-loss bug. Here it only ever *adds* candidates,
 * and a caller that ends up matching more than one account must refuse rather
 * than pick one - see findByIdentifier in routes/api.ts.
 */
export function phoneCandidates(value: unknown): string[] {
  const digits = normalizePhone(value);
  if (!digits) return [];
  const out = new Set<string>([digits]);
  if (digits.length === 11 && digits.startsWith("1")) out.add(digits.slice(1));
  if (digits.length === 10) out.add(`1${digits}`);
  return [...out];
}

/**
 * Whether an identifier was meant as a phone number rather than an email.
 *
 * Used to route a single "email or phone" login field to the right column. The
 * @ test comes first so an address is never mistaken for a phone number.
 */
export function isPhoneLike(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.includes("@")) return false;
  const digits = normalizePhone(value);
  return digits.length >= 3 && digits.length <= 15;
}

/** A phone_norm to store, or NULL when there is no usable number. */
export function phoneNormOrNull(value: unknown): string | null {
  return normalizePhone(value) || null;
}