
import * as srp from '@getinsomnia/srp-js';
import { type ActionFunction } from 'react-router-dom';

import { userSession as sessionModel } from '../../models';
import type { UserSession } from '../../models/user-session';
import { base64encode, saveVaultKeyToKeyChainIfNecessary } from '../../utils/vault';
import { insomniaFetch } from '../insomniaFetch';

const {
  Buffer,
  Client,
  generateAES256Key,
  getRandomHex,
  params,
  srpGenKey,
} = srp;

export const vaultKeyParams = params[2048];
const vaultKeyRequestBathPath = '/v1/user/vault';

const createVaultKeyRequest = async (sessionId: string, salt: string, verifier: string) =>
  insomniaFetch({
    method: 'POST',
    path: vaultKeyRequestBathPath,
    data: { salt, verifier },
    sessionId,
  }).catch(error => {
    console.error(error);;
  });

const resetVaultKeyRequest = async (sessionId: string, salt: string, verifier: string) =>
  insomniaFetch({
    method: 'POST',
    path: `${vaultKeyRequestBathPath}/reset`,
    sessionId,
    data: { salt, verifier },
  }).catch(error => {
    console.error(error);;
  });

export const saveVaultKey = async (session: UserSession, vaultKey: string) => {
  const { accountId } = session;
  // save encrypted vault key and vault salt to session
  const encryptedVaultKey = await window.main.keyChain.encryptString(vaultKey);
  await sessionModel.update(session, { vaultKey: encryptedVaultKey });

  // save raw vault key to keychain if necessary
  await saveVaultKeyToKeyChainIfNecessary(accountId, vaultKey);
};

const createVaultKey = async (type: 'create' | 'reset' = 'create') => {
  const userSession = await sessionModel.getOrCreate();
  const { accountId, id: sessionId } = userSession;

  // const vaultKey = await getVaultKeyRequest(sessionId);
  const vaultSalt = await getRandomHex();
  const newVaultKey = await generateAES256Key();
  const base64encodedVaultKey = base64encode(JSON.stringify(newVaultKey));

  try {
    // Compute the verifier
    const verifier = srp
      .computeVerifier(
        vaultKeyParams,
        Buffer.from(vaultSalt, 'hex'),
        Buffer.from(accountId, 'utf8'),
        Buffer.from(base64encodedVaultKey, 'base64'),
      )
      .toString('hex');
    // send or reset saltAuth & verifier to server
    if (type === 'create') {
      await createVaultKeyRequest(sessionId, vaultSalt, verifier);
    } else {
      await resetVaultKeyRequest(sessionId, vaultSalt, verifier);
    };

    // save encrypted vault key and vault salt to session
    await sessionModel.update(userSession, { vaultSalt: vaultSalt });
    await saveVaultKey(userSession, base64encodedVaultKey);
    return base64encodedVaultKey;
  } catch (error) {
    return { error: error.toString() };
  }
};

export const validateVaultKey = async (session: UserSession, vaultKey: string, vaultSalt: string) => {
  const { id: sessionId, accountId } = session;
  const secret1 = await srpGenKey();
  const srpClient = new Client(
    vaultKeyParams,
    Buffer.from(vaultSalt, 'hex'),
    Buffer.from(accountId, 'utf8'),
    Buffer.from(vaultKey, 'base64'),
    Buffer.from(secret1, 'hex'),
  );
  // ~~~~~~~~~~~~~~~~~~~~~ //
  // Compute and Submit A  //
  // ~~~~~~~~~~~~~~~~~~~~~ //
  const srpA = srpClient.computeA().toString('hex');
  const { sessionStarterId, srpB, error: verifyAError } = await insomniaFetch<{
    sessionStarterId: string;
    srpB: string;
    error?: string;
    message?: string;
  }>({
    method: 'POST',
    path: '/v1/user/vault-verify-a',
    data: { srpA },
    sessionId,
  });
  // ~~~~~~~~~~~~~~~~~~~~~ //
  // Compute and Submit M1 //
  // ~~~~~~~~~~~~~~~~~~~~~ //
  srpClient.setB(new Buffer(srpB, 'hex'));
  const srpM1 = srpClient.computeM1().toString('hex');
  const { srpM2, error: verifyM1Error } = await insomniaFetch<{
    srpM2: string;
    error?: string;
    message?: string;
  }>({
    method: 'POST',
    path: '/v1/user/vault-verify-m1',
    data: { srpM1, sessionStarterId },
    sessionId,
  });
  if (verifyAError || verifyM1Error) {
    return false;
  }
  // ~~~~~~~~~~~~~~~~~~~~~~~~~ //
  // Verify Server Identity M2 //
  // ~~~~~~~~~~~~~~~~~~~~~~~~~ //
  srpClient.checkM2(new Buffer(srpM2, 'hex'));
  const srpK = srpClient.computeK().toString('hex');
  return srpK;
};

export const createVaultKeyAction: ActionFunction = async () => {
  return createVaultKey('create');
};

export const resetVaultKeyAction: ActionFunction = async () => {
  return createVaultKey('reset');
};

export const validateVaultKeyAction: ActionFunction = async ({ request }) => {
  const { vaultKey, saveVaultKey: saveVaultKeyLocally = false } = await request.json();
  const userSession = await sessionModel.getOrCreate();
  const { vaultSalt } = userSession;

  if (!vaultSalt) {
    return { error: 'Please generate a vault key from preference first' };
  }

  try {
    const validateResult = await validateVaultKey(userSession, vaultKey, vaultSalt);
    if (!validateResult) {
      return { error: 'Invalid vault key, please check and input again' };
    }
    if (saveVaultKeyLocally) {
      await saveVaultKey(userSession, vaultKey);
    };
    return { vaultKey, srpK: validateResult };
  } catch (error) {
    return { error: error.toString() };
  };
};