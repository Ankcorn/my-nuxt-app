// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },

  nitro: {
    preset: "./nuxt-otel.ts"
  },

  modules: ["nitro-cloudflare-dev"]
})