import { join } from 'node:path';
import { answerInput } from '../src/agent.js';
import { openStore } from '../src/store.js';
import { fixtureModels, model } from './fixture-model.js';

const directory = process.argv[2];
const store = openStore(join(directory, 'gateway.sqlite'));
const models = fixtureModels(() => {
  process.send('model-started');
  return undefined;
});
const keepAlive = setInterval(() => {}, 1000);
await answerInput({ directory, store, models, model, row: store.nextInput() });
clearInterval(keepAlive);
