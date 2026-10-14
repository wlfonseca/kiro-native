#!/usr/bin/env node
import { login } from "../dist/index.js"
const cmd = process.argv[2]
if (cmd === "login") {
  await login()
} else {
  console.error("uso: kiro-native login")
  process.exit(1)
}
