// src/index.ts
import { Context } from '@deepseek-ai/cordis'

const root = new Context()

await root.plugin({
  name: 'mini-sessions',
  apply(ctx) {
    console.log('plugin loaded')
  },
})

await root.plugin({
  name: 'mini-tools',
  apply(ctx) {
    console.log('plugin loaded')
  },
})

await root.plugin({
  name: 'mini-llm',
  apply(ctx) {
    console.log('plugin loaded')
  },
})