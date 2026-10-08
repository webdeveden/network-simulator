import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import { useAuth } from './stores/auth'
import './style.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/HomeView.vue') },
    { path: '/missions', component: () => import('./views/MissionsView.vue') },
    { path: '/missions/:id', component: () => import('./views/MissionPlayView.vue'), props: true },
    { path: '/sandbox', component: () => import('./views/SandboxView.vue') },
    { path: '/login', component: () => import('./views/LoginView.vue') },
  ],
})

const app = createApp(App).use(createPinia())

router.beforeEach(async () => {
  await useAuth().init()
})

app.use(router).mount('#app')
