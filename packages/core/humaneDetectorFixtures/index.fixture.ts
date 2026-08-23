/**
 * Sample sources the deterministic detectors are tested against.
 *
 * These are STRINGS, not compiled modules: the detectors take file contents, so a fixture
 * is a file's contents. Keeping them out of the test file itself is what makes the paired
 * fire / near-miss structure legible — the two members of a pair sit next to each other and
 * differ only in the thing under test.
 */

export * from './equity.fixture.ts';
export * from './choices.fixture.ts';
export * from './honesty.fixture.ts';
export * from './attentionAndDignity.fixture.ts';
export * from './scope.fixture.ts';
