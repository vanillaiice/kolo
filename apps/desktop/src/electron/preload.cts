import electron = require("electron");
import type { DesktopBridge } from "./ipc.js";

const { contextBridge, ipcRenderer } = electron;
const bridge: DesktopBridge = {
  getStatus: () => ipcRenderer.invoke("kolo:installation-status"),
  getWorkspace: () => ipcRenderer.invoke("kolo:workspace"),
  createShop: input => ipcRenderer.invoke("kolo:setup", input),
  finishSetup: input => ipcRenderer.invoke("kolo:finish-setup", input),
  unlock: input => ipcRenderer.invoke("kolo:unlock", input),
  lock: () => ipcRenderer.invoke("kolo:lock"),
  recoverAccess: input => ipcRenderer.invoke("kolo:recover", input),
  recoveryKey: input => ipcRenderer.invoke("kolo:recovery-key", input),
  listProducts: input => ipcRenderer.invoke("kolo:products", input),
  getProduct: input => ipcRenderer.invoke("kolo:product", input),
  scanProduct: input => ipcRenderer.invoke("kolo:scan", input),
  createProduct: input => ipcRenderer.invoke("kolo:create-product", input),
  updateProduct: input => ipcRenderer.invoke("kolo:update-product", input),
  setProductActive: input => ipcRenderer.invoke("kolo:product-active", input),
  listCategories: input => ipcRenderer.invoke("kolo:categories", input),
  createCategory: input => ipcRenderer.invoke("kolo:create-category", input),
  updateCategory: input => ipcRenderer.invoke("kolo:update-category", input),
  moveStock: input => ipcRenderer.invoke("kolo:move-stock", input),
  countStock: input => ipcRenderer.invoke("kolo:count-stock", input),
  stockHistory: input => ipcRenderer.invoke("kolo:stock-history", input),
  listCashAccounts: input => ipcRenderer.invoke("kolo:cash-accounts", input),
  checkout: input => ipcRenderer.invoke("kolo:checkout", input),
  getReceipt: input => ipcRenderer.invoke("kolo:receipt", input),
  listReceipts: input => ipcRenderer.invoke("kolo:receipts", input),
  onChanged: listener => {
    const notify = (): void => listener();
    ipcRenderer.on("kolo:changed", notify);
    return () => { ipcRenderer.removeListener("kolo:changed", notify); };
  },
};
contextBridge.exposeInMainWorld("kolo", bridge);
