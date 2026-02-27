import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { sha512ToGrumpkinScalar } from "@aztec/foundation/crypto/sha512";
import { DOM_SEP__MSK_M_GEN } from "./constants.js";
/**
 * Derive the master migration secret key from an account's secret key.
 * Uses `sha512ToGrumpkinScalar` with {@link DOM_SEP__MSK_M_GEN} as a domain separator.
 *
 * @param secretKey - The account's master secret key.
 * @returns A Grumpkin scalar used as the migration signing / encryption key.
 */
export function deriveMasterMigrationSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DOM_SEP__MSK_M_GEN]);
}
