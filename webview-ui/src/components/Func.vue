<script setup lang="ts">
import type { ABIAttr, ABIItem } from "../types";

interface Props {
  func: ABIItem
};

const { func } = defineProps<Props>();
const emit = defineEmits(["query", "call"]);

function funcSignature(f: ABIItem): string {
  const name = f.name ?? "";
  // FIXME in case name is empty
  const params = f.inputs?.map(x => `${x.type} ${x.name}`).join(", ");

  return `function ${name}(${params}) ${f.stateMutability}`;
}
function handleInput(input: ABIAttr, idx: number, event: any) {
  if (input.type.includes("[]")) {
    if (Array.isArray(input.value)) {
      input.value[idx] = event.target.value;
    } else {
      input.value = [event.target.value];
    }
  } else {
    input.value = event.target.value;
  }
}

function handleClick(input: ABIAttr, idx: number) {
  input.value.splice(idx, 1);
}

</script>

<template>
  <section class="component-container">
    <h2>{{ funcSignature(func) }}</h2>

    <div class="component-item" v-if="func.stateMutability==='payable'">
      <vscode-text-field size="46" @input="func.amount = $event.target.value" value="">amount</vscode-text-field>
      <vscode-dropdown class="append" @change="func.amountUnit = $event.target.value">
        <vscode-option v-for="(unit, idx) in ['vite', 'attov']" :key="idx" :value="unit">{{ unit }}</vscode-option>
      </vscode-dropdown>
    </div>

    <div class="component-item" :class="{'array-input': Array.isArray(input.value) && input.value.length > 0}" v-for="(input, i) in func.inputs" :key="i">
      <template v-if="Array.isArray(input.value) && input.value.length" v-for="(item, idx) in input.value">
        <section class="array-input-item">
          <vscode-text-field size="60" @input="handleInput(input, idx, $event)" :value="item ?? ''">
            <span v-if="idx === 0">{{ input.name }}: {{ input.type }}</span>
          </vscode-text-field>
          <vscode-button appearance="secondary" v-if="idx < input.value.length" @click="handleClick(input, idx)">Delete</vscode-button>
        </section>
        <vscode-text-field size="60" v-if="idx+1 === input.value.length" @input="handleInput(input, idx + 1, $event)"></vscode-text-field>
      </template>
      <vscode-text-field v-else size="60" @input="handleInput(input, 0, $event)" :value="input.value">
        {{ input.name }}: {{ input.type }}
      </vscode-text-field>
    </div>

    <div class="component-item">
      <vscode-button @click="emit('query')" v-if="func.stateMutability === 'view' || func.stateMutability === 'pure'">
        query {{ func.name }}()
      </vscode-button>
      <vscode-button @click="emit('call')" v-else>
        call {{func.name}}()
      </vscode-button>
    </div>

    <div class="component-item call-result" v-if="func.callResult?.sendBlock?.hash">
      <strong>sendBlock hash:</strong> {{func.callResult.sendBlock.hash}}
    </div>
    <div class="component-item call-result" v-if="func.callResult?.sendBlock?.confirmedHash">
      <strong>sendBlock confirmedHash:</strong> {{func.callResult.sendBlock.confirmedHash}}
    </div>

    <div class="component-item" v-if="func.callResult?.receiveBlock?.hash">
      <strong>receiveBlock hash:</strong> {{ func.callResult.receiveBlock.hash }}
    </div>

    <div class="component-item" v-if="func.callResult?.receiveBlock?.confirmedHash">
      <strong>receiveBlock confirmedHash:</strong> {{ func.callResult.receiveBlock.confirmedHash }}
    </div>

    <div class="component-item" v-if="func.callResult?.errorMessage">
      <strong style="color: var(--vscode-errorForeground)">Error:</strong> {{func.callResult.errorMessage}}
    </div>

    <div class="component-item" v-if="func.queryResult?.errorMessage">
      <strong style="color: var(--vscode-errorForeground)">Error:</strong> {{func.queryResult.errorMessage}}
    </div>

    <div class="component-item" v-if="func.outputs?.find(x => x.value !== undefined)" v-for="(output, idx) in func.outputs"
      :key="idx">
      <strong>{{output.type}} {{output.name}}:</strong> {{output.value}}
    </div>
  </section>
</template>

<style>
.component-item.array-input {
  flex-direction: column;
  align-items: flex-start;
}
.array-input-item {
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: 0.6rem;
  margin-bottom: 0.6rem;
}
.array-input-item:first-child vscode-button{
  margin-top: 17px;
}
</style>