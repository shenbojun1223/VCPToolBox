"use strict";

const { SidecarError } = require("./protocol");

const AICW_PROVIDER_FINALIZATION_UNCONFIRMED = "AICW_PROVIDER_FINALIZATION_UNCONFIRMED";
const AICW_PROVIDER_EXECUTION_INVALID = "AICW_PROVIDER_EXECUTION_INVALID";
const AICW_PROVIDER_LISTENER_INVALID = "AICW_PROVIDER_LISTENER_INVALID";
const AICW_PROVIDER_STOP_TIMEOUT_INVALID = "AICW_PROVIDER_STOP_TIMEOUT_INVALID";
const DEFAULT_PROVIDER_STOP_TIMEOUT_MS = 10_000;

function isEventName(value) {
    return typeof value === "string" || typeof value === "symbol";
}

function isConfirmedStopResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
        return value.confirmed === true;
    } catch {
        return false;
    }
}

function resolveStopTimeout(options) {
    const configured = options.stopTimeoutMs ?? options.timeoutMs;
    if (configured === undefined) return DEFAULT_PROVIDER_STOP_TIMEOUT_MS;
    const timeoutMs = typeof configured === "number" ? configured : Number(configured);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new SidecarError(
            AICW_PROVIDER_STOP_TIMEOUT_INVALID,
            "Provider execution stop timeout must be a finite number greater than zero"
        );
    }
    return timeoutMs;
}

function finalizationUnconfirmed(reason) {
    return new SidecarError(
        AICW_PROVIDER_FINALIZATION_UNCONFIRMED,
        "Provider execution stop was not confirmed",
        { reason }
    );
}

class ProviderExecutionLifecycle {
    constructor(execution, options = {}) {
        if (!execution || typeof execution.stop !== "function") {
            throw new SidecarError(
                AICW_PROVIDER_EXECUTION_INVALID,
                "Provider execution must expose stop()"
            );
        }

        const normalizedOptions = options && typeof options === "object" ? options : {};
        this.execution = execution;
        this.stopTimeoutMs = resolveStopTimeout(normalizedOptions);
        this._listeners = new Map();
        this._stopPromise = null;
        this._status = "created";
        this._stopped = false;
        this._confirmed = false;
    }

    get status() {
        return this._status;
    }

    get stopped() {
        return this._stopped;
    }

    get confirmed() {
        return this._confirmed;
    }

    attach(eventName, listener) {
        if (!isEventName(eventName) || typeof listener !== "function") {
            throw new SidecarError(
                AICW_PROVIDER_LISTENER_INVALID,
                "Provider execution listener requires an event name and function"
            );
        }
        if (typeof this.execution.on !== "function") {
            throw new SidecarError(
                AICW_PROVIDER_EXECUTION_INVALID,
                "Provider execution does not support event listeners"
            );
        }

        let eventListeners = this._listeners.get(eventName);
        if (!eventListeners) {
            eventListeners = new Map();
            this._listeners.set(eventName, eventListeners);
        }
        if (eventListeners.has(listener)) return this;

        const forwarder = function providerExecutionEventForwarder(...args) {
            return listener.apply(this, args);
        };
        this.execution.on(eventName, forwarder);
        eventListeners.set(listener, forwarder);
        return this;
    }

    detach(eventName, listener) {
        if (!isEventName(eventName) || typeof listener !== "function") {
            throw new SidecarError(
                AICW_PROVIDER_LISTENER_INVALID,
                "Provider execution listener requires an event name and function"
            );
        }

        const eventListeners = this._listeners.get(eventName);
        const forwarder = eventListeners?.get(listener);
        if (!forwarder) return this;

        try {
            if (typeof this.execution.off === "function") {
                this.execution.off(eventName, forwarder);
            } else if (typeof this.execution.removeListener === "function") {
                this.execution.removeListener(eventName, forwarder);
            } else {
                throw new SidecarError(
                    AICW_PROVIDER_EXECUTION_INVALID,
                    "Provider execution does not support listener removal"
                );
            }
        } finally {
            eventListeners.delete(listener);
            if (eventListeners.size === 0) this._listeners.delete(eventName);
        }
        return this;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;

        this._status = "stopping";
        let resolveStop;
        let rejectStop;
        const stopPromise = new Promise((resolve, reject) => {
            resolveStop = resolve;
            rejectStop = reject;
        });
        this._stopPromise = stopPromise;
        this._runStop(resolveStop, rejectStop);
        return stopPromise;
    }

    _runStop(resolveStop, rejectStop) {
        let settled = false;
        let timer = null;

        const clearStopTimer = () => {
            if (timer === null) return;
            clearTimeout(timer);
            timer = null;
        };

        const rejectUnconfirmed = reason => {
            if (settled) return;
            settled = true;
            clearStopTimer();
            this._status = "unconfirmed";
            this._stopped = false;
            this._confirmed = false;
            rejectStop(finalizationUnconfirmed(reason));
        };

        const resolveConfirmed = result => {
            if (settled) return;
            if (!isConfirmedStopResult(result)) {
                rejectUnconfirmed("non-confirming-result");
                return;
            }
            settled = true;
            clearStopTimer();
            this._status = "stopped";
            this._stopped = true;
            this._confirmed = true;
            resolveStop(result);
        };

        try {
            timer = setTimeout(() => rejectUnconfirmed("timeout"), this.stopTimeoutMs);
            if (timer && typeof timer.unref === "function") timer.unref();

            const result = this.execution.stop({ suppressClosed: true });
            Promise.resolve(result).then(resolveConfirmed, () => rejectUnconfirmed("rejected"));
        } catch {
            rejectUnconfirmed("rejected");
        }
    }
}

function createProviderExecutionLifecycle(execution, options) {
    return new ProviderExecutionLifecycle(execution, options);
}

module.exports = {
    AICW_PROVIDER_FINALIZATION_UNCONFIRMED,
    AICW_PROVIDER_EXECUTION_INVALID,
    AICW_PROVIDER_LISTENER_INVALID,
    AICW_PROVIDER_STOP_TIMEOUT_INVALID,
    DEFAULT_PROVIDER_STOP_TIMEOUT_MS,
    isConfirmedStopResult,
    ProviderExecutionLifecycle,
    createProviderExecutionLifecycle
};
