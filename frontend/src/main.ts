import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import { useAuth } from './stores/auth'
import './style.css'

// After a deploy, an open tab may ask for page files that no longer exist (new hashed names).
// Reload once to get the new index.html; the flag stops an endless loop if the file is really missing.
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem('reloadedAfterDeploy')) return
  sessionStorage.setItem('reloadedAfterDeploy', '1')
  event.preventDefault()
  window.location.reload()
})
window.addEventListener('load', () => sessionStorage.removeItem('reloadedAfterDeploy'))

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
