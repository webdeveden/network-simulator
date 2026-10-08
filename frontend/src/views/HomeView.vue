<script setup lang="ts">
import { RouterLink } from 'vue-router'

const features = [
  ['Build', 'Drag PCs, switches, routers, servers and firewalls onto the grid and cable them together.'],
  ['Configure', 'Assign IPs, subnets, gateways, static routes and firewall rules from the GUI or the CLI.'],
  ['Simulate', 'Watch packets travel hop by hop. ARP, MAC learning, routing and filtering are all simulated.'],
  ['Learn', 'Each failure tells you why: no gateway, no route, ARP timeout, blocked by rule #2.'],
]
</script>

<template>
  <div class="h-full overflow-y-auto">
    <section class="mx-auto max-w-4xl px-6 py-16">
      <pre class="text-neon glow text-[10px] leading-tight sm:text-xs">
 ███╗   ██╗███████╗████████╗███████╗██╗███╗   ███╗
 ████╗  ██║██╔════╝╚══██╔══╝██╔════╝██║████╗ ████║
 ██╔██╗ ██║█████╗     ██║   ███████╗██║██╔████╔██║
 ██║╚██╗██║██╔══╝     ██║   ╚════██║██║██║╚██╔╝██║
 ██║ ╚████║███████╗   ██║   ███████║██║██║ ╚═╝ ██║
 ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚══════╝╚═╝╚═╝     ╚═╝</pre>
      <p class="mt-4 text-sm text-cyan">// network &amp; cyber security simulator</p>
      <p class="mt-4 max-w-2xl leading-relaxed text-text">
        Design networks, configure them, and keep attackers out. Work through missions that teach how
        real networks behave, from your first cable to firewall rules.
      </p>
      <div class="mt-8 flex gap-3">
        <RouterLink to="/missions" class="btn btn-primary px-6! py-2!">&gt; start missions</RouterLink>
        <RouterLink to="/sandbox" class="btn px-6! py-2!">&gt; open sandbox</RouterLink>
      </div>

      <div class="mt-14 grid gap-4 sm:grid-cols-2">
        <div v-for="[title, text] in features" :key="title" class="panel p-4">
          <div class="text-xs font-semibold tracking-widest text-magenta uppercase">{{ title }}</div>
          <p class="mt-2 text-xs leading-relaxed text-dim">{{ text }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
