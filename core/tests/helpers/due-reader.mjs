// Reader module for the worker-isolation test: the board "evil" hangs the thread in a catastrophic regex, every other board answers.
export async function read(entry) {
  if (entry.name === 'evil') /(a+)+$/.test('a'.repeat(60) + 'b');   // exponential: never returns
  return { ok: true, items: [{ url: `https://boards.greenhouse.io/x/jobs/${entry.name}`, title: `Job ${entry.name}`, location: 'Berlin' }], complete: true, provider: 'greenhouse' };
}
