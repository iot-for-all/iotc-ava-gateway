export function forget(fireAndForgetAsyncFunc: any, ...params: any[]): void {
    void (async () => {
        await fireAndForgetAsyncFunc(...params);
    })().catch();
}
