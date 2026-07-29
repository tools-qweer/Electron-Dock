import path from "node:path";
import { refreshNativeHelperFallback } from "./build-native-helper.mjs";

const root = path.resolve(import.meta.dirname, "..");
await refreshNativeHelperFallback(root);
