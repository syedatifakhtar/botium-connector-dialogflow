const util = require('util')
const uuidV1 = require('uuid/v1')
const dialogflow = require('dialogflow')
const debug = require('debug')('botium-connector-dialogflow')

const structjson = require('./structjson')

var storage = {};
const Capabilities = {
    DIALOGFLOW_PROJECT_ID: 'DIALOGFLOW_PROJECT_ID',
    DIALOGFLOW_CLIENT_EMAIL: 'DIALOGFLOW_CLIENT_EMAIL',
    DIALOGFLOW_PRIVATE_KEY: 'DIALOGFLOW_PRIVATE_KEY',
    DIALOGFLOW_LANGUAGE_CODE: 'DIALOGFLOW_LANGUAGE_CODE',
    DIALOGFLOW_USE_INTENT: 'DIALOGFLOW_USE_INTENT',
    DIALOGFLOW_INPUT_CONTEXT_NAME: 'DIALOGFLOW_INPUT_CONTEXT_NAME',
    DIALOGFLOW_INPUT_CONTEXT_LIFESPAN: 'DIALOGFLOW_INPUT_CONTEXT_LIFESPAN',
    DIALOGFLOW_INPUT_CONTEXT_PARAMETERS: 'DIALOGFLOW_INPUT_CONTEXT_PARAMETERS'
}

const Defaults = {
    [Capabilities.DIALOGFLOW_LANGUAGE_CODE]: 'en-US',
    [Capabilities.DIALOGFLOW_USE_INTENT]: false
}

function findTextToSpeechInFulfillmentOrPayload(response) {
    let fromFulfillmentText = lookup(response.queryResult.fulfillmentMessages, 'textToSpeech');
    let fromMessagesOrPayload = (fromFulfillmentText === undefined || fromFulfillmentText === null) ?
        lookup(structjson.structProtoToJson(response.queryResult.webhookPayload), 'textToSpeech') : fromFulfillmentText;
    let fromMessagesOrPayloadOrText = (fromMessagesOrPayload === undefined || fromMessagesOrPayload === null) ?
        lookup(response, 'fulfillmentText') : fromMessagesOrPayload;
    return fromMessagesOrPayloadOrText;
}

function isDefined(object) {
    return object !== null && object !== undefined;
}

function storeUserDetails(response) {
    if (
        isDefined(response.queryResult.webhookPayload)
        && isDefined(structjson.structProtoToJson(response.queryResult.webhookPayload).google)
        && isDefined(structjson.structProtoToJson(response.queryResult.webhookPayload).google.userStorage)
    ) {
        storage = structjson.structProtoToJson(response.queryResult.webhookPayload).google.userStorage;
    }
}

class BotiumConnectorDialogflow {
    constructor({queueBotSays, caps}) {
        this.queueBotSays = queueBotSays
        this.caps = caps
    }

    Validate() {
        debug('Validate called')
        if (!this.caps[Capabilities.DIALOGFLOW_PROJECT_ID]) throw new Error('DIALOGFLOW_PROJECT_ID capability required')
        if (!this.caps[Capabilities.DIALOGFLOW_CLIENT_EMAIL]) throw new Error('DIALOGFLOW_CLIENT_EMAIL capability required')
        if (!this.caps[Capabilities.DIALOGFLOW_PRIVATE_KEY]) throw new Error('DIALOGFLOW_PRIVATE_KEY capability required')
        if (!this.caps[Capabilities.DIALOGFLOW_LANGUAGE_CODE]) this.caps[Capabilities.DIALOGFLOW_LANGUAGE_CODE] = Defaults[Capabilities.DIALOGFLOW_LANGUAGE_CODE]
        return Promise.resolve()
    }

    Build() {
        debug('Build called')
        this.sessionOpts = {
            credentials: {
                client_email: this.caps[Capabilities.DIALOGFLOW_CLIENT_EMAIL],
                private_key: this.caps[Capabilities.DIALOGFLOW_PRIVATE_KEY]
            }
        }
        return Promise.resolve()
    }

    Start() {
        debug('Start called')

        this.sessionClient = new dialogflow.SessionsClient(this.sessionOpts)
        this.conversationId = uuidV1()
        this.sessionPath = this.sessionClient.sessionPath(this.caps[Capabilities.DIALOGFLOW_PROJECT_ID], this.conversationId)
        this.queryParams = null

        if (!this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_NAME] || !this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_LIFESPAN]) {
            return Promise.resolve()
        }

        this.contextClient = new dialogflow.ContextsClient(this.sessionOpts)
        const contextPath = this.contextClient.contextPath(this.caps[Capabilities.DIALOGFLOW_PROJECT_ID],
            this.conversationId, this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_NAME])
        const context = {
            lifespanCount: parseInt(this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_LIFESPAN]),
            name: contextPath
        }
        if (this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_PARAMETERS]) {
            context.parameters = structjson.jsonToStructProto(this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_PARAMETERS])
        }
        const request = {parent: this.sessionPath, context: context}
        return this.contextClient.createContext(request)
    }

    UserSays(msg) {
        debug('UserSays called')
        if (!this.sessionClient) return Promise.reject(new Error('not built'))

        return new Promise((resolve, reject) => {
            const request = {
                session: this.sessionPath,
                queryInput: {
                    text: {
                        text: msg.messageText,
                        languageCode: this.caps[Capabilities.DIALOGFLOW_LANGUAGE_CODE]
                    }
                }
            };

            let params = structjson.jsonToStructProto({
                source: 'ACTIONS_ON_GOOGLE', user: {userStorage: JSON.stringify(storage)}

            });

            request.queryParams = {

                payload: params
            };


            this.sessionClient.detectIntent(request).then((responses) => {
                const response = responses[0]
                debug(`dialogflow response: ${util.inspect(response)}`)

                response.queryResult.outputContexts.forEach(context => {
                    context.parameters = structjson.jsonToStructProto(
                        structjson.structProtoToJson(context.parameters)
                    )
                })
                this.queryParams = {
                    contexts: response.queryResult.outputContexts
                }
                storeUserDetails(response);
                this.queueBotSays({
                        sender: 'bot',
                        sourceData: response.queryResult,
                        messageText: findTextToSpeechInFulfillmentOrPayload(response)[1]
                    }
                );
                resolve(this);

                if (this.caps[Capabilities.DIALOGFLOW_USE_INTENT]) {
                    if (response.queryResult.intent) {
                        const botMsg = {
                            sender: 'bot',
                            sourceData: response.queryResult,
                            messageText: response.queryResult.intent.displayName
                        }
                        this.queueBotSays(botMsg)
                    }
                } else {
                    if (response.queryResult.fulfillmentText) {
                        const botMsg = {
                            sender: 'bot',
                            sourceData: response.queryResult,
                            messageText: response.queryResult.fulfillmentText
                        }
                        this.queueBotSays(botMsg)
                    }
                }
            }).catch((err) => {
                reject(new Error(`Cannot send message to dialogflow container: ${util.inspect(err)}`))
            })
        })
    }


    Stop() {
        debug('Stop called');
        this.sessionClient = null;
        this.sessionPath = null;
        this.queryParams = null;
        return Promise.resolve()
    }

    Clean() {
        debug('Clean called')
        this.sessionOpts = null
        return Promise.resolve()
    }
}

function lookup(obj, k) {
    for (let key in obj) {

        let value = obj[key];
        if (k == key) return [k, value];

        if (type(value) == "Object") {
            var y = lookup(value, k);
            if (y && y[0] == k) return y;
        }
        if (type(value) == "Array") {
            for (var i = 0; i < value.length; ++i) {
                var x = lookup(value[i], k);
                if (x && x[0] == k) return x;
            }
        }
    }

    return null;
}

function type(object) {
    var stringConstructor = "test".constructor;
    var arrayConstructor = [].constructor;
    var objectConstructor = {}.constructor;

    if (object === null) {
        return "null";
    } else if (object === undefined) {
        return "undefined";
    } else if (object.constructor === stringConstructor) {
        return "String";
    } else if (object.constructor === arrayConstructor) {
        return "Array";
    } else if (object.constructor === objectConstructor) {
        return "Object";
    } else {
        return "null";
    }
}

module.exports = {
    PluginVersion: 1,
    PluginClass: BotiumConnectorDialogflow
}
