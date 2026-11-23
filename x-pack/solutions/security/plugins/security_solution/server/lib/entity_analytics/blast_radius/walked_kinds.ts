/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// The relationship kinds an attack path follows, as the edges index stores them: holding the
// entity at one end gives an attacker the entity at the other. The reader filters by these in the
// query, so a kind missing from both lists below is never read. Typed kinds in the Entity Store
// are where a new kind would get a decision.

export const WALKED_KINDS = [
  'member_of',
  'nested_in',
  'local_admin',
  'credentials_left',
  // A machine holding its person's sign-in session: control the machine, reuse the session.
  'session_left',
  'stores_credentials',
  'can_replicate',
  'sso_to_role',
  'app_assignment',
  'can_assume',
  'external_trust',
  'oidc_trust',
  'can_push',
  'bucket_policy',
  'role_policy',
  'user_policy',
  'group_policy',
  'access_point_policy',
  'fronts',
  'decrypt',
  'can_read',
  'holds_its_password',
  'can_control',
  'runs_as',
  'same_machine',
] as const;

/** Kinds that are stored but not walked, and why. */
export const NOT_WALKED: Readonly<Record<string, string>> = {
  owns: 'owning an account does not give its credentials',
  'resolution.resolved_to':
    'resolution by email ties a person to their accounts, not an attack path (resolution by SID would be walked)',
  accesses_frequently: 'logons are ephemeral and not part of the core graph',
  accesses_infrequently: 'logons are ephemeral and not part of the core graph',
  encrypted_with: 'describes the bucket, it does not grant access',
};
