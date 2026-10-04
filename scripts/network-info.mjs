import os from "node:os";

const port = Number(process.env.PORT || 3000);
const addresses = [];
for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
  for (const item of interfaces || []) {
    if (item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")) {
      addresses.push({ name, address: item.address });
    }
  }
}

console.log(`Local: http://localhost:${port}`);
if (!addresses.length) {
  console.log("No se encontró una dirección IPv4 de red local.");
  process.exit(0);
}
console.log("Direcciones para otro dispositivo conectado a la misma red:");
for (const item of addresses) console.log(`- ${item.name}: http://${item.address}:${port}`);
console.log("Si no abre, permite Node.js en el Firewall de Windows para redes privadas.");
