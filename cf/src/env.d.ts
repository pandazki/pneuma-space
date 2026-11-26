interface Env {
  PNEUMA_SPACE_TURN_KEY_ID?: string;
  PNEUMA_SPACE_TURN_API_TOKEN?: string;
}
/** ES2026, built into workerd; TypeScript's ES2023 library does not declare it yet. */
interface Uint8ArrayConstructor {
  fromBase64(base64: string): Uint8Array<ArrayBuffer>;
}
