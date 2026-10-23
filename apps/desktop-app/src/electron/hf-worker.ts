/**
 * DeepSeek Harness Desktop — Hugging Face local inference Worker.
 *
 * Runs @xenova/transformers in a separate Node worker thread so the UI
 * never blocks while a local model generates text. Results are streamed
 * back to the renderer via parentPort + IPC in the main process.
 */

import { parentPort, workerData } from 'node:worker_threads';

interface HFWorkerData {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  streamId: string;
}

let aborted = false;

async function run() {
  const { model, prompt, temperature, maxTokens, streamId } = workerData as HFWorkerData;

  const { pipeline } = await import('@xenova/transformers');

  const generator = await pipeline('text-generation', model);

  // transformers.js v2 types do not expose the streaming AsyncGenerator,
  // so we cast through any to use the runtime stream: true API.
  const stream = (await (generator as any)(prompt, {
    stream: true,
    max_new_tokens: maxTokens,
    temperature,
  })) as AsyncGenerator<any>;

  for await (const chunk of stream) {
    if (aborted) break;
    const text = chunk?.token?.text ?? chunk?.generated_text ?? '';
    if (text) {
      parentPort?.postMessage({ type: 'text', content: text, streamId });
    }
  }

  parentPort?.postMessage({ type: 'done', streamId });
}

run().catch((err: Error) => {
  parentPort?.postMessage({ type: 'error', error: err.message, streamId: (workerData as HFWorkerData).streamId });
});

export function abort() {
  aborted = true;
}
