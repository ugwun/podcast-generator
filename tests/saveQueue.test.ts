import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaveQueue } from '../web/src/saveQueue.ts';

function harness() {
  const sent: string[] = [];
  const saved: string[] = [];
  const errors: string[] = [];
  const gates: { resolve(): void; reject(reason: Error): void }[] = [];
  const queue = createSaveQueue<string, string>({
    save: (value) =>
      new Promise((resolve, reject) => {
        sent.push(value);
        gates.push({ resolve: () => resolve(value), reject });
      }),
    onSaved: (value) => saved.push(value),
    onError: (reason) => errors.push(reason.message),
    delayMs: 5,
  });
  return { queue, sent, saved, errors, gates };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('flush waits for a save that is already on its way', async () => {
  const { queue, gates } = harness();
  queue.schedule('prvy');
  void queue.flush();
  await tick();
  let finished = false;
  const flushed = queue.flush().then(() => (finished = true));
  await tick();
  assert.equal(finished, false);
  gates[0].resolve();
  await flushed;
  assert.equal(finished, true);
});

test('saves run one at a time and an older response never replaces newer text', async () => {
  const { queue, sent, saved, gates } = harness();
  queue.schedule('a');
  void queue.flush();
  await tick();
  queue.schedule('b');
  const flushed = queue.flush();
  await tick();
  assert.deepEqual(sent, ['a']);
  gates[0].resolve();
  await tick();
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(saved, []);
  gates[1].resolve();
  await flushed;
  assert.deepEqual(saved, ['b']);
  assert.equal(queue.dirty(), false);
});

test('a rejected save keeps the text and the next flush sends it again', async () => {
  const { queue, sent, gates } = harness();
  queue.schedule('text');
  const first = queue.flush();
  await tick();
  gates[0].reject(new Error('409'));
  await assert.rejects(first);
  assert.equal(queue.dirty(), true);
  const second = queue.flush();
  await tick();
  gates[1].resolve();
  await second;
  assert.deepEqual(sent, ['text', 'text']);
  assert.equal(queue.dirty(), false);
});

test('the debounce timer reports failures instead of dropping them', async () => {
  const { queue, errors, gates } = harness();
  queue.schedule('text');
  await new Promise((resolve) => setTimeout(resolve, 15));
  gates[0].reject(new Error('Epizoda sa prave spracuva.'));
  await tick();
  assert.deepEqual(errors, ['Epizoda sa prave spracuva.']);
});
