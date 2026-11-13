import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import ClassPage from './student/ClassPage.vue'

// As in QuestRush, "/" is the teacher's class list when signed in and the public class picker when signed out (App.vue).
// Teachers sign in at /teacher/sign-in, which nothing in the app links to; signed out, other teacher pages go home.
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('./teacher/TeacherHome.vue'), meta: { teacher: true } },
  {
    path: '/c/:classToken/:slug?',
    component: ClassPage,
    props: (route) => ({ classToken: String(route.params.classToken) }),
  },
  {
    path: '/teacher/classes/:classId',
    component: () => import('./teacher/TeacherClass.vue'),
    props: true,
    meta: { teacher: true },
  },
  {
    path: '/teacher/sign-in',
    name: 'teacher-sign-in',
    component: () => import('./components/LoginScreen.vue'),
    meta: { teacher: true },
  },
  { path: '/teacher', redirect: '/' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({ history: createWebHistory(), routes })
