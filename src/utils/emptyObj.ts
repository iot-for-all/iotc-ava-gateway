export function emptyObj(object: any): boolean {
    return !Object.keys(object || {}).length;
}
