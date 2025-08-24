import keytar from "keytar";

const SERVICE = "WirePeekBrowser";

export async function saveCred(origin: string, username: string, password: string) {
    const account = `${origin}:${username}`;
    await keytar.setPassword(SERVICE, account, password);
    return true;
}

export async function listCreds(origin: string) {
    const all = await keytar.findCredentials(SERVICE);
    return all
        .filter(c => c.account.startsWith(`${origin}:`))
        .map(c => ({ username: c.account.split(":")[1], password: c.password }));
}

export async function deleteCred(origin: string, username: string) {
    const account = `${origin}:${username}`;
    return keytar.deletePassword(SERVICE, account);
}
