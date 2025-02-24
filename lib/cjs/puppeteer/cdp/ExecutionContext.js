"use strict";
/**
 * @license
 * Copyright 2017 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        function next() {
            while (env.stack.length) {
                var rec = env.stack.pop();
                try {
                    var result = rec.dispose && rec.dispose.call(rec.value);
                    if (rec.async) return Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                }
                catch (e) {
                    fail(e);
                }
            }
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionContext = void 0;
const CDPSession_js_1 = require("../api/CDPSession.js");
const EventEmitter_js_1 = require("../common/EventEmitter.js");
const LazyArg_js_1 = require("../common/LazyArg.js");
const ScriptInjector_js_1 = require("../common/ScriptInjector.js");
const util_js_1 = require("../common/util.js");
const AsyncIterableUtil_js_1 = require("../util/AsyncIterableUtil.js");
const disposable_js_1 = require("../util/disposable.js");
const Function_js_1 = require("../util/Function.js");
const Mutex_js_1 = require("../util/Mutex.js");
const AriaQueryHandler_js_1 = require("./AriaQueryHandler.js");
const Binding_js_1 = require("./Binding.js");
const ElementHandle_js_1 = require("./ElementHandle.js");
const JSHandle_js_1 = require("./JSHandle.js");
const utils_js_1 = require("./utils.js");
const ariaQuerySelectorBinding = new Binding_js_1.Binding('__ariaQuerySelector', AriaQueryHandler_js_1.ARIAQueryHandler.queryOne, '' // custom init
);
const ariaQuerySelectorAllBinding = new Binding_js_1.Binding('__ariaQuerySelectorAll', (async (element, selector) => {
    const results = AriaQueryHandler_js_1.ARIAQueryHandler.queryAll(element, selector);
    return await element.realm.evaluateHandle((...elements) => {
        return elements;
    }, ...(await AsyncIterableUtil_js_1.AsyncIterableUtil.collect(results)));
}), '' // custom init
);
/**
 * @internal
 */
class ExecutionContext extends EventEmitter_js_1.EventEmitter {
    #client;
    #world;
    #id;
    _frameId;
    #name;
    #disposables = new disposable_js_1.DisposableStack();
    constructor(client, contextPayload, world) {
        super();
        this.#client = client;
        this.#world = world;
        this.#id = contextPayload.id;
        if (contextPayload.name) {
            this.#name = contextPayload.name;
        }
        // rebrowser-patches: keep frameId to use later
        if (contextPayload.auxData?.frameId) {
            this._frameId = contextPayload.auxData?.frameId;
        }
        const clientEmitter = this.#disposables.use(new EventEmitter_js_1.EventEmitter(this.#client));
        clientEmitter.on('Runtime.bindingCalled', this.#onBindingCalled.bind(this));
        if (process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] === '0') {
            clientEmitter.on('Runtime.executionContextDestroyed', async (event) => {
                if (event.executionContextId === this.#id) {
                    this[disposable_js_1.disposeSymbol]();
                }
            });
            clientEmitter.on('Runtime.executionContextsCleared', async () => {
                this[disposable_js_1.disposeSymbol]();
            });
        }
        clientEmitter.on('Runtime.consoleAPICalled', this.#onConsoleAPI.bind(this));
        clientEmitter.on(CDPSession_js_1.CDPSessionEvent.Disconnected, () => {
            this[disposable_js_1.disposeSymbol]();
        });
    }
    // Contains mapping from functions that should be bound to Puppeteer functions.
    #bindings = new Map();
    // If multiple waitFor are set up asynchronously, we need to wait for the
    // first one to set up the binding in the page before running the others.
    #mutex = new Mutex_js_1.Mutex();
    async #addBinding(binding) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            if (this.#bindings.has(binding.name)) {
                return;
            }
            const _ = __addDisposableResource(env_1, await this.#mutex.acquire(), false);
            try {
                await this.#client.send('Runtime.addBinding', this.#name
                    ? {
                        name: utils_js_1.CDP_BINDING_PREFIX + binding.name,
                        executionContextName: this.#name,
                    }
                    : {
                        name: utils_js_1.CDP_BINDING_PREFIX + binding.name,
                        executionContextId: this.#id,
                    });
                await this.evaluate(utils_js_1.addPageBinding, 'internal', binding.name, utils_js_1.CDP_BINDING_PREFIX);
                this.#bindings.set(binding.name, binding);
            }
            catch (error) {
                // We could have tried to evaluate in a context which was already
                // destroyed. This happens, for example, if the page is navigated while
                // we are trying to add the binding
                if (error instanceof Error) {
                    // Destroyed context.
                    if (error.message.includes('Execution context was destroyed')) {
                        return;
                    }
                    // Missing context.
                    if (error.message.includes('Cannot find context with specified id')) {
                        return;
                    }
                }
                (0, util_js_1.debugError)(error);
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async #onBindingCalled(event) {
        if (event.executionContextId !== this.#id) {
            return;
        }
        let payload;
        try {
            payload = JSON.parse(event.payload);
        }
        catch {
            // The binding was either called by something in the page or it was
            // called before our wrapper was initialized.
            return;
        }
        const { type, name, seq, args, isTrivial } = payload;
        if (type !== 'internal') {
            this.emit('bindingcalled', event);
            return;
        }
        if (!this.#bindings.has(name)) {
            this.emit('bindingcalled', event);
            return;
        }
        try {
            const binding = this.#bindings.get(name);
            await binding?.run(this, seq, args, isTrivial);
        }
        catch (err) {
            (0, util_js_1.debugError)(err);
        }
    }
    get id() {
        return this.#id;
    }
    #onConsoleAPI(event) {
        if (event.executionContextId !== this.#id) {
            return;
        }
        this.emit('consoleapicalled', event);
    }
    #bindingsInstalled = false;
    #puppeteerUtil;
    get puppeteerUtil() {
        let promise = Promise.resolve();
        if (!this.#bindingsInstalled) {
            promise = Promise.all([
                this.#addBindingWithoutThrowing(ariaQuerySelectorBinding),
                this.#addBindingWithoutThrowing(ariaQuerySelectorAllBinding),
            ]);
            this.#bindingsInstalled = true;
        }
        ScriptInjector_js_1.scriptInjector.inject(script => {
            if (this.#puppeteerUtil) {
                void this.#puppeteerUtil.then(handle => {
                    void handle.dispose();
                });
            }
            this.#puppeteerUtil = promise.then(() => {
                return this.evaluateHandle(script);
            });
        }, !this.#puppeteerUtil);
        return this.#puppeteerUtil;
    }
    async #addBindingWithoutThrowing(binding) {
        try {
            await this.#addBinding(binding);
        }
        catch (err) {
            // If the binding cannot be added, then either the browser doesn't support
            // bindings (e.g. Firefox) or the context is broken. Either breakage is
            // okay, so we ignore the error.
            (0, util_js_1.debugError)(err);
        }
    }
    /**
     * Evaluates the given function.
     *
     * @example
     *
     * ```ts
     * const executionContext = await page.mainFrame().executionContext();
     * const result = await executionContext.evaluate(() => Promise.resolve(8 * 7))* ;
     * console.log(result); // prints "56"
     * ```
     *
     * @example
     * A string can also be passed in instead of a function:
     *
     * ```ts
     * console.log(await executionContext.evaluate('1 + 2')); // prints "3"
     * ```
     *
     * @example
     * Handles can also be passed as `args`. They resolve to their referenced object:
     *
     * ```ts
     * const oneHandle = await executionContext.evaluateHandle(() => 1);
     * const twoHandle = await executionContext.evaluateHandle(() => 2);
     * const result = await executionContext.evaluate(
     *   (a, b) => a + b,
     *   oneHandle,
     *   twoHandle
     * );
     * await oneHandle.dispose();
     * await twoHandle.dispose();
     * console.log(result); // prints '3'.
     * ```
     *
     * @param pageFunction - The function to evaluate.
     * @param args - Additional arguments to pass into the function.
     * @returns The result of evaluating the function. If the result is an object,
     * a vanilla object containing the serializable properties of the result is
     * returned.
     */
    async evaluate(pageFunction, ...args) {
        return await this.#evaluate(true, pageFunction, ...args);
    }
    /**
     * Evaluates the given function.
     *
     * Unlike {@link ExecutionContext.evaluate | evaluate}, this method returns a
     * handle to the result of the function.
     *
     * This method may be better suited if the object cannot be serialized (e.g.
     * `Map`) and requires further manipulation.
     *
     * @example
     *
     * ```ts
     * const context = await page.mainFrame().executionContext();
     * const handle: JSHandle<typeof globalThis> = await context.evaluateHandle(
     *   () => Promise.resolve(self)
     * );
     * ```
     *
     * @example
     * A string can also be passed in instead of a function.
     *
     * ```ts
     * const handle: JSHandle<number> = await context.evaluateHandle('1 + 2');
     * ```
     *
     * @example
     * Handles can also be passed as `args`. They resolve to their referenced object:
     *
     * ```ts
     * const bodyHandle: ElementHandle<HTMLBodyElement> =
     *   await context.evaluateHandle(() => {
     *     return document.body;
     *   });
     * const stringHandle: JSHandle<string> = await context.evaluateHandle(
     *   body => body.innerHTML,
     *   body
     * );
     * console.log(await stringHandle.jsonValue()); // prints body's innerHTML
     * // Always dispose your garbage! :)
     * await bodyHandle.dispose();
     * await stringHandle.dispose();
     * ```
     *
     * @param pageFunction - The function to evaluate.
     * @param args - Additional arguments to pass into the function.
     * @returns A {@link JSHandle | handle} to the result of evaluating the
     * function. If the result is a `Node`, then this will return an
     * {@link ElementHandle | element handle}.
     */
    async evaluateHandle(pageFunction, ...args) {
        return await this.#evaluate(false, pageFunction, ...args);
    }
    // rebrowser-patches: alternative to dispose
    clear(newId) {
        this.#id = newId;
        this.#bindings = new Map();
        this.#bindingsInstalled = false;
        this.#puppeteerUtil = undefined;
    }
    // rebrowser-patches: get context id if it's missing
    async acquireContextId(tryCount = 1) {
        if (this.#id > 0) {
            return;
        }
        const fixMode = process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] || 'addBinding';
        process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][acquireContextId] id = ${this.#id}, name = ${this.#name}, fixMode = ${fixMode}, tryCount = ${tryCount}`);
        let contextId;
        if (fixMode === 'addBinding') {
            try {
                if (this.#id === -2) {
                    // isolated world
                    const sendRes = await this.#client.send('Page.createIsolatedWorld', {
                        frameId: this._frameId,
                        worldName: this.#name,
                        grantUniveralAccess: true,
                    });
                    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][acquireContextId] Page.createIsolatedWorld result:`, sendRes);
                    contextId = sendRes.executionContextId;
                }
                else {
                    // main world
                    // random name to make it harder to detect for any 3rd party script by watching window object and events
                    const randomName = [...Array(Math.floor(Math.random() * (10 + 1)) + 10)].map(() => Math.random().toString(36)[2]).join('');
                    process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][acquireContextId] binding name = ${randomName}`);
                    // add the binding
                    await this.#client.send('Runtime.addBinding', {
                        name: randomName,
                    });
                    // listen for 'Runtime.bindingCalled' event
                    const bindingCalledHandler = ({ name, payload, executionContextId }) => {
                        process.env['REBROWSER_PATCHES_DEBUG'] && console.log('[rebrowser-patches][bindingCalledHandler]', {
                            name,
                            payload,
                            executionContextId
                        });
                        if (contextId > 0) {
                            // already acquired the id
                            return;
                        }
                        if (name !== randomName) {
                            // ignore irrelevant bindings
                            return;
                        }
                        if (payload !== this._frameId) {
                            // ignore irrelevant frames
                            return;
                        }
                        contextId = executionContextId;
                        // remove this listener
                        this.#client.off('Runtime.bindingCalled', bindingCalledHandler);
                    };
                    this.#client.on('Runtime.bindingCalled', bindingCalledHandler);
                    // we could call the binding right from addScriptToEvaluateOnNewDocument, but this way it will be called in all existing frames and it's hard to distinguish children from the parent
                    await this.#client.send('Page.addScriptToEvaluateOnNewDocument', {
                        source: `document.addEventListener('${randomName}', (e) => self['${randomName}'](e.detail.frameId))`,
                        runImmediately: true,
                    });
                    // create new isolated world for this frame
                    const createIsolatedWorldRes = await this.#client.send('Page.createIsolatedWorld', {
                        frameId: this._frameId,
                        // use randomName for worldName to distinguish from normal utility world
                        worldName: randomName,
                        grantUniveralAccess: true,
                    });
                    // emit event in the specific frame from the isolated world
                    await this.#client.send('Runtime.evaluate', {
                        expression: `document.dispatchEvent(new CustomEvent('${randomName}', { detail: { frameId: '${this._frameId}' } }))`,
                        contextId: createIsolatedWorldRes.executionContextId,
                    });
                }
            }
            catch (error) {
                process.env['REBROWSER_PATCHES_DEBUG'] && console.error('[rebrowser-patches][acquireContextId] error:', error);
                if (error instanceof Error) {
                    // Missing frame
                    if (error.message.includes('No frame for given id found')) {
                        return;
                    }
                }
                (0, util_js_1.debugError)(error);
            }
        }
        else if (fixMode === 'alwaysIsolated') {
            if (this.#id === -3) {
                throw new Error('[rebrowser-patches] web workers are not supported in alwaysIsolated mode');
            }
            const sendRes = await this.#client
                .send('Page.createIsolatedWorld', {
                frameId: this._frameId,
                worldName: this.#name,
                grantUniveralAccess: true,
            });
            process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][acquireContextId] Page.createIsolatedWorld result:`, sendRes);
            contextId = sendRes.executionContextId;
        }
        else if (fixMode === 'enableDisable') {
            const executionContextCreatedHandler = ({ context }) => {
                process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][executionContextCreated] this.#id = ${this.#id}, name = ${this.#name}, contextId = ${contextId}, event.context.id = ${context.id}`);
                if (contextId > 0) {
                    // already acquired the id
                    return;
                }
                if (this.#id === -1) {
                    // main world
                    if (context.auxData && context.auxData['isDefault']) {
                        contextId = context.id;
                    }
                }
                else if (this.#id === -2) {
                    // utility world
                    if (this.#name === context.name) {
                        contextId = context.id;
                    }
                }
                else if (this.#id === -3) {
                    // web worker
                    contextId = context.id;
                }
            };
            this.#client.on('Runtime.executionContextCreated', executionContextCreatedHandler);
            await this.#client.send('Runtime.enable');
            await this.#client.send('Runtime.disable');
            this.#client.off('Runtime.executionContextCreated', executionContextCreatedHandler);
        }
        if (!contextId) {
            if (tryCount >= 3) {
                throw new Error('[rebrowser-patches] acquireContextId failed');
            }
            process.env['REBROWSER_PATCHES_DEBUG'] && console.log(`[rebrowser-patches][acquireContextId] failed, try again (tryCount = ${tryCount})`);
            return this.acquireContextId(tryCount + 1);
        }
        this.#id = contextId;
    }
    async #evaluate(returnByValue, pageFunction, ...args) {
        // rebrowser-patches: context id is missing, acquire it and try again
        if (this.#id < 0) {
            await this.acquireContextId();
            // @ts-ignore
            return this.#evaluate(returnByValue, pageFunction, ...args);
        }
        const sourceUrlComment = (0, util_js_1.getSourceUrlComment)((0, util_js_1.getSourcePuppeteerURLIfAvailable)(pageFunction)?.toString() ??
            util_js_1.PuppeteerURL.INTERNAL_URL);
        if ((0, util_js_1.isString)(pageFunction)) {
            const contextId = this.#id;
            const expression = pageFunction;
            const expressionWithSourceUrl = util_js_1.SOURCE_URL_REGEX.test(expression)
                ? expression
                : `${expression}\n${sourceUrlComment}\n`;
            const { exceptionDetails, result: remoteObject } = await this.#client
                .send('Runtime.evaluate', {
                expression: expressionWithSourceUrl,
                contextId,
                returnByValue,
                awaitPromise: true,
                userGesture: true,
            })
                .catch(rewriteError);
            if (exceptionDetails) {
                throw (0, utils_js_1.createEvaluationError)(exceptionDetails);
            }
            return returnByValue
                ? (0, utils_js_1.valueFromRemoteObject)(remoteObject)
                : this.#world.createCdpHandle(remoteObject);
        }
        const functionDeclaration = (0, Function_js_1.stringifyFunction)(pageFunction);
        const functionDeclarationWithSourceUrl = util_js_1.SOURCE_URL_REGEX.test(functionDeclaration)
            ? functionDeclaration
            : `${functionDeclaration}\n${sourceUrlComment}\n`;
        let callFunctionOnPromise;
        try {
            callFunctionOnPromise = this.#client.send('Runtime.callFunctionOn', {
                functionDeclaration: functionDeclarationWithSourceUrl,
                executionContextId: this.#id,
                // LazyArgs are used only internally and should not affect the order
                // evaluate calls for the public APIs.
                arguments: args.some(arg => {
                    return arg instanceof LazyArg_js_1.LazyArg;
                })
                    ? await Promise.all(args.map(arg => {
                        return convertArgumentAsync(this, arg);
                    }))
                    : args.map(arg => {
                        return convertArgument(this, arg);
                    }),
                returnByValue,
                awaitPromise: true,
                userGesture: true,
            });
        }
        catch (error) {
            if (error instanceof TypeError &&
                error.message.startsWith('Converting circular structure to JSON')) {
                error.message += ' Recursive objects are not allowed.';
            }
            throw error;
        }
        const { exceptionDetails, result: remoteObject } = await callFunctionOnPromise.catch(rewriteError);
        if (exceptionDetails) {
            throw (0, utils_js_1.createEvaluationError)(exceptionDetails);
        }
        return returnByValue
            ? (0, utils_js_1.valueFromRemoteObject)(remoteObject)
            : this.#world.createCdpHandle(remoteObject);
        async function convertArgumentAsync(context, arg) {
            if (arg instanceof LazyArg_js_1.LazyArg) {
                arg = await arg.get(context);
            }
            return convertArgument(context, arg);
        }
        function convertArgument(context, arg) {
            if (typeof arg === 'bigint') {
                // eslint-disable-line valid-typeof
                return { unserializableValue: `${arg.toString()}n` };
            }
            if (Object.is(arg, -0)) {
                return { unserializableValue: '-0' };
            }
            if (Object.is(arg, Infinity)) {
                return { unserializableValue: 'Infinity' };
            }
            if (Object.is(arg, -Infinity)) {
                return { unserializableValue: '-Infinity' };
            }
            if (Object.is(arg, NaN)) {
                return { unserializableValue: 'NaN' };
            }
            const objectHandle = arg && (arg instanceof JSHandle_js_1.CdpJSHandle || arg instanceof ElementHandle_js_1.CdpElementHandle)
                ? arg
                : null;
            if (objectHandle) {
                if (objectHandle.realm !== context.#world) {
                    throw new Error('JSHandles can be evaluated only in the context they were created!');
                }
                if (objectHandle.disposed) {
                    throw new Error('JSHandle is disposed!');
                }
                if (objectHandle.remoteObject().unserializableValue) {
                    return {
                        unserializableValue: objectHandle.remoteObject().unserializableValue,
                    };
                }
                if (!objectHandle.remoteObject().objectId) {
                    return { value: objectHandle.remoteObject().value };
                }
                return { objectId: objectHandle.remoteObject().objectId };
            }
            return { value: arg };
        }
    }
    [disposable_js_1.disposeSymbol]() {
        this.#disposables.dispose();
        this.emit('disposed', undefined);
    }
}
exports.ExecutionContext = ExecutionContext;
const rewriteError = (error) => {
    if (error.message.includes('Object reference chain is too long')) {
        return { result: { type: 'undefined' } };
    }
    if (error.message.includes("Object couldn't be returned by value")) {
        return { result: { type: 'undefined' } };
    }
    if (error.message.endsWith('Cannot find context with specified id') ||
        error.message.endsWith('Inspected target navigated or closed')) {
        throw new Error('Execution context was destroyed, most likely because of a navigation.');
    }
    throw error;
};
//# sourceMappingURL=ExecutionContext.js.map