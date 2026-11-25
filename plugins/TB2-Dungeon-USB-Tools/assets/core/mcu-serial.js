
/** Fixed read-only CDC query, independent of the Flipper WebUSB transport.
 * https://developer.chrome.com/docs/capabilities/serial
 */
class McuUsbSerial {
    static FILTER = {usbVendorId:0x2FE3, usbProductId:0x0100};
    static COMMAND = 'prod toniebox_info_get\r';
    static TIMEOUT_MS = 10000;
    static MAX_TEXT = 65536;
    static BAUD_RATE = 115200;
    /** Accept a complete field, never a truncated prefix of a longer identifier. */
    static extract(text, details = false) {
        // Shell output may surround the JSON response; wait for a complete object.
        for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
            let depth = 0, quoted = false, escaped = false;
            for (let end = start; end < text.length; end++) {
                const character = text[end];
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (character === '\\') escaped = true;
                    else if (character === '"') quoted = false;
                    continue;
                }
                if (character === '"') { quoted = true; continue; }
                if (character === '{') depth++;
                if (character !== '}' || --depth !== 0) continue;
                let response;
                try { response = JSON.parse(text.slice(start, end + 1)); }
                catch { break; } // A shell/log fragment is not a protocol response.
                // Only the successful fixed command may publish its named MCU serial number.
                if (response.type === 'result' && response.command === 'toniebox_info_get' &&
                    response.success === true && Array.isArray(response.result)) {
                    const field = response.result.find(entry => entry?.name === 'mcu_sn');
                    if (typeof field?.result === 'string' && /^[0-9a-f]{16}$/i.test(field.result)) {
                        const uuid = field.result.toUpperCase();
                        const serial = response.result.filter(entry => entry?.name === 'toniebox_id');
                        if (response.result.filter(entry => entry?.name === 'mcu_sn').length !== 1 || serial.length > 1)
                            throw new Error('Serial query returned duplicate identity fields.');
                        const boxSerialNumber = serial.length ? BoxIdentity.serial(serial[0].result) : '';
                        return details ? {uuid, boxSerialNumber} : uuid;
                    }
                }
                break;
            }
        }
        // Retain the earlier direct-field format without accepting a truncated identifier.
        const match = /(?:^|[\s,{])(?:"mcu_sn"|'mcu_sn'|mcu_sn)\s*[:=]\s*(?:"([0-9a-f]{16})"|'([0-9a-f]{16})'|([0-9a-f]{16})(?=[\r\n,}]))/i.exec(text);
        const uuid = match ? (match[1] || match[2] || match[3]).toUpperCase() : null;
        return uuid && details ? {uuid, boxSerialNumber:''} : uuid;
    }
    /** Port selection must be called directly from a user gesture. No retry or transcript storage. */
    static async read(serial, signal, timeoutMs = this.TIMEOUT_MS, details = false) {
        let port;
        try { port=await serial.requestPort({filters:[this.FILTER]}); }
        catch(error) { throw new Error(error.name==='NotFoundError'?'Port selection cancelled.':'USB port selection failed.'); }
        return this.readPort(port, signal, timeoutMs, details);
    }
    /** Read an explicitly selected, previously granted port. Never invokes a browser chooser. */
    static async readPort(port, signal, timeoutMs = this.TIMEOUT_MS, details = false) {
        if (signal.aborted) throw new Error('Cancelled. No command sent.');
        if (port.connected !== true) throw new Error('Serial port disconnected.');
        let opened=false, reader, writer, reading, timer, abortHandler, failure, uuid;
        let text='', stopped=false;
        try {
            const info=port.getInfo();
            if(info.usbVendorId!==this.FILTER.usbVendorId || info.usbProductId!==this.FILTER.usbProductId) throw new Error('Wrong USB device selected.');
            await port.open({baudRate:this.BAUD_RATE});opened=true;
            if(signal.aborted) throw new Error('Cancelled. No command sent.');
            reader=port.readable.getReader();writer=port.writable.getWriter();
            const decoder=new TextDecoder();
            reading=(async()=>{
                while(true){
                    const {value,done}=await reader.read();
                    if(done) throw new Error('Connection closed; no valid mcu_sn received.');
                    text+=decoder.decode(value,{stream:true});
                    if(text.length>this.MAX_TEXT) throw new Error('Response too large; query stopped.');
                    const found=this.extract(text, details);
                    if(found)return found;
                }
            })();
            const interrupted=new Promise((_,reject)=>{
                timer=setTimeout(()=>reject(new Error('Timeout: no valid mcu_sn received.')),timeoutMs);
                abortHandler=()=>reject(new Error('Query cancelled.'));
                signal.addEventListener('abort',abortHandler,{once:true});
                if(signal.aborted)abortHandler();
            });
            // Observe read errors immediately, including while setSignals/write is pending.
            const transaction=(async()=>{
                await port.setSignals({dataTerminalReady:true});
                if(signal.aborted || stopped)throw new Error('Query cancelled.');
                await writer.write(new TextEncoder().encode(this.COMMAND));
                return await reading;
            })();
            uuid=await Promise.race([transaction, interrupted, reading.then(()=>transaction)]);
        } catch(error) {
            // Browser errors may contain device details: never expose raw errors or response text.
            failure=error instanceof Error && /^(Cancelled|Query cancelled|Timeout:|Connection closed;|Response too large;|Wrong USB)/.test(error.message)
                ? error : new Error('Serial query failed. The port may be busy or disconnected.');
        } finally {
            stopped=true;
            clearTimeout(timer);signal.removeEventListener('abort',abortHandler);
            const cleanupErrors=[];
            if(reader){try{await reader.cancel();}catch(e){cleanupErrors.push(e);} if(reading)await reading.catch(()=>{});reader.releaseLock();}
            if(writer){try{if(failure)await writer.abort();}catch(e){cleanupErrors.push(e);}writer.releaseLock();}
            if(opened){try{await port.close();}catch(e){cleanupErrors.push(e);}}
            text='';
            if(cleanupErrors.length)failure=new Error('Could not close the serial port cleanly. UUID not accepted.');
        }
        if(failure)throw failure;
        return uuid;
    }
}
