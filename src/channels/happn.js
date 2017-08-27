/*
 * Copyright (c) 2017, Hugo Freire <hugo@exec.sh>.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* eslint-disable camelcase */

const HAPPN_FACEBOOK_LOGIN_APP_CLIENT_ID = '247294518656661'
const HAPPN_FACEBOOK_LOGIN_APP_REDIRECT_URI = 'https://www.happn.fr'
const HAPPN_FACEBOOK_LOGIN_APP_OPTIONAL_PARAMS = { scope: 'basic_info', response_type: 'token' }

const Channel = require('./channel')

const _ = require('lodash')
const Promise = require('bluebird')

const { NotAuthorizedError } = require('./errors')

const { HappnWrapper, HappnNotAuthorizedError } = require('happn-wrapper')

const Database = require('../database')

const defaultOptions = {
  oauth: {
    facebook: {
      clientId: HAPPN_FACEBOOK_LOGIN_APP_CLIENT_ID,
      redirectUri: HAPPN_FACEBOOK_LOGIN_APP_REDIRECT_URI,
      optionalParams: HAPPN_FACEBOOK_LOGIN_APP_OPTIONAL_PARAMS
    }
  },
  channel: { is_enabled: false }
}

class Happn extends Channel {
  constructor (options = {}) {
    super('happn')

    this._options = _.defaults(options, defaultOptions)

    this._happn = new HappnWrapper()
  }

  authorize () {
    const authorize = function ({ facebookAccessToken }) {
      return this._happn.authorize(facebookAccessToken)
        .then(() => {
          return { userId: this._happn.userId, accessToken: this._happn.accessToken }
        })
    }

    return this.findOrAuthorizeIfNeeded(authorize.bind(this))
      .then((channel) => {
        this._happn.userId = channel.userId
        this._happn.accessToken = channel.accessToken
      })
  }

  getRecommendations () {
    return Promise.try(() => {
      if (!this._happn.accessToken) {
        throw new NotAuthorizedError()
      }
    })
      .then(() => this._happn.getRecommendations(16))
      .then(({ data }) => data)
      .mapSeries((data) => {
        return {
          channelName: 'happn',
          channelRecommendationId: data.notifier.id,
          name: data.notifier.first_name,
          photos: _.map(data.notifier.profiles, (photo) => _.pick(photo, [ 'url', 'id' ])),
          data
        }
      })
      .catch(HappnNotAuthorizedError, () => this.onNotAuthorizedError.bind(this)())
  }

  getUpdates () {
    return Promise.try(() => {
      if (!this._happn.accessToken) {
        throw new NotAuthorizedError()
      }
    })
      .then(() => Database.channels.find({ where: { name: this._name } }))
      .then(({ lastActivityDate, userId }) => {
        const _lastActivityDate = !lastActivityDate ? undefined : lastActivityDate

        return this._happn.getUpdates(_lastActivityDate)
          .then(({ conversations }) => {
            return Database.channels.update({ lastActivityDate: new Date() }, { where: { name: this._name } })
              .then(() => {
                return Promise.mapSeries(conversations, (conversation) => {
                  const channelRecommendationId = _(conversation.participants)
                    .map('user.id')
                    .filter((id) => id !== userId)
                    .value()[ 0 ]

                  const _isNewMatch = (channelRecommendationId) => {
                    return Database.recommendations.findOne({
                      where: {
                        channelName: 'happn',
                        channelRecommendationId
                      }
                    })
                      .then((recommendation) => {
                        if (recommendation === null) {
                          return true
                        }

                        return !recommendation.isMatch
                      })
                  }

                  return Promise.props({
                    isNewMatch: _isNewMatch(channelRecommendationId),
                    recommendation: this.getUser(channelRecommendationId)
                  })
                    .then(({ isNewMatch, recommendation }) => {
                      recommendation.channelMatchId = channelRecommendationId
                      recommendation.matchedDate = new Date(conversation.creation_date)

                      const messages = _.map(conversation.messages, (message) => {
                        return {
                          channelName: 'happn',
                          channelMessageId: message.id,
                          recommendationId: channelRecommendationId,
                          isFromRecommendation: message.sender.id !== userId,
                          sentDate: new Date(message.creation_date.replace(/T/, ' ').replace(/\..+/, '')),
                          text: message.message
                        }
                      })

                      return { isNewMatch, recommendation, messages }
                    })
                })
              })
          })
      })
      .catch(HappnNotAuthorizedError, () => this.onNotAuthorizedError.bind(this)())
  }

  like (userId) {
    if (!userId) {
      return Promise.reject(new Error('invalid arguments'))
    }

    return Promise.try(() => {
      if (!this._happn.accessToken) {
        throw new NotAuthorizedError()
      }
    })
      .then(() => this._happn.like(userId))
      .then(() => this._happn.getUser(userId))
      .then(({ data }) => {
        if (data.my_relation === 4) {
          return {
            channelName: 'happn',
            channelRecommendationId: data.id,
            name: data.first_name,
            photos: _.map(data.profiles, (photo) => _.pick(photo, [ 'url', 'id' ])),
            channelMatchId: data.id,
            matchedDate: new Date(),
            data
          }
        }
      })
      .catch(HappnNotAuthorizedError, () => this.onNotAuthorizedError.bind(this)())
  }

  getUser (userId) {
    if (!userId) {
      return Promise.reject(new Error('invalid arguments'))
    }

    return Promise.try(() => {
      if (!this._happn.accessToken) {
        throw new NotAuthorizedError()
      }
    })
      .then(() => this._happn.getUser(userId))
      .then(({ data }) => {
        return {
          channelName: 'happn',
          channelRecommendationId: data.id,
          name: data.first_name,
          photos: _.map(data.profiles, (photo) => _.pick(photo, [ 'url', 'id' ])),
          data
        }
      })
      .catch(HappnNotAuthorizedError, () => this.onNotAuthorizedError.bind(this)())
  }

  onNotAuthorizedError () {
    this._happn.accessToken = undefined
    this._happn.refreshToken = undefined
    this._happn.userId = undefined

    return super.onNotAuthorizedError()
  }
}

module.exports = new Happn()
