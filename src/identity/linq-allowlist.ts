/** Check the verified sender locally; missing or malformed configuration blocks responses. */
export function assessLinqResponseAccess(
  senderHandle: string,
  allowedNumbers = process.env.LINQ_ALLOWED_NUMBERS,
) {
  if (!allowedNumbers?.trim()) {
    return { accepted: false as const, reason: "responses_disabled" as const };
  }
  const numbers = allowedNumbers.split(",").map((number) => number.trim());
  if (numbers.some((number) => !/^\+[1-9]\d{6,14}$/.test(number))) {
    return { accepted: false as const, reason: "response_allowlist_invalid" as const };
  }
  if (!numbers.includes(senderHandle)) {
    return { accepted: false as const, reason: "sender_not_allowlisted" as const };
  }
  return { accepted: true as const };
}
