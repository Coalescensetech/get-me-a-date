/*
 * Copyright (c) 2017, Hugo Freire <hugo@exec.sh>.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

const AWS_REGION = process.env.AWS_REGION
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET
const AWS_REKOGNITION_COLLECTION = process.env.AWS_REKOGNITION_COLLECTION || 'get-me-a-tinder-date'

const _ = require('lodash')
const Promise = require('bluebird')

const Logger = require('modern-logger')

const S3 = require('../utils/s3')
const Rekognition = require('../utils/rekognition')

const request = Promise.promisifyAll(require('request').defaults({ encoding: null }))

const { parse } = require('url')

const deleteFaces = function (faces) {
  return this.rekognition.deleteFaces(AWS_REKOGNITION_COLLECTION, faces)
    .then(() => faces.length)
    .catch((error) => Logger.warn(error))
}

const indexFacesFromImages = function (images) {
  let indexedFaces = 0

  return Promise.map(images, (image) => {
    return this.rekognition.indexFaces(AWS_REKOGNITION_COLLECTION, AWS_S3_BUCKET, image)
      .then((data) => {
        if (!data.FaceRecords) {
          return
        }

        // delete images with no or multiple faces
        if (data.FaceRecords.length !== 1) {
          return this.rekognition.deleteFaces(AWS_REKOGNITION_COLLECTION, _.map(data.FaceRecords, ({ Face }) => Face.FaceId))
            .then(() => {
              return this.s3.deleteObject(image)
            })
        }

        indexedFaces++
      })
      .catch((error) => {
        if (_.some([ 'InvalidImageFormatException', 'InvalidParameterException' ], (message) => _.includes(error.code, message))) {
          return this.s3.deleteObject(image)
        }

        return Logger.warn(error)
      })
  }, { concurrency: 2 })
    .then(() => indexedFaces)
}

const savePhoto = function (photo) {
  if (!photo) {
    return Promise.reject(new Error('invalid arguments'))
  }

  const url = parse(photo.url)
  if (!url) {
    return Promise.reject(new Error('invalid photo url'))
  }

  return request.getAsync(url.href)
    .then(({ body }) => {
      return this.s3.putObject(`photos/tinder${url.pathname}`, body)
        .then(() => {
          photo.url = `https://s3-${AWS_REGION}.amazonaws.com/${AWS_S3_BUCKET}/photos/tinder${url.pathname}`

          return body
        })
    })
}

const compareFacesFromImage = function (photo, image) {
  return this.rekognition.searchFacesByImage(AWS_REKOGNITION_COLLECTION, image)
    .then(({ FaceMatches }) => {
      photo.similarity = _.round(_.max(_.map(FaceMatches, 'Similarity')), 2) || 0
      photo.similarity_date = new Date().toISOString()

      return photo.similarity
    })
    .catch((error) => {
      if (_.some([ 'InvalidImageFormatException', 'InvalidParameterException' ], (message) => _.includes(error.code, message))) {
        photo.similarity = 0
        photo.similarity_date = new Date().toISOString()

        return photo.similarity
      }

      throw error
    })
}

class Taste {
  constructor () {
    this.rekognition = new Rekognition({
      region: AWS_REGION,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY
    })

    this.s3 = new S3({
      region: AWS_REGION,
      bucket: AWS_S3_BUCKET,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY
    })
  }

  bootstrap () {
    return this.createRekognitionCollectionIfNeeded()
      .then(() => this.syncS3BucketAndRekognitionCollection())
  }

  createRekognitionCollectionIfNeeded () {
    return this.rekognition.listCollections()
      .then((collectionIds) => {
        if (!_.includes(collectionIds, AWS_REKOGNITION_COLLECTION)) {
          return this.rekognition.createCollection(AWS_REKOGNITION_COLLECTION)
        }
      })
  }

  syncS3BucketAndRekognitionCollection () {
    const start = _.now()

    return Promise.props({
      currentFaces: this.rekognition.listFaces(AWS_REKOGNITION_COLLECTION),
      availableImages: this.s3.listObjects('train')
    })
      .then(({ currentFaces, availableImages }) => {
        const { Faces } = currentFaces
        const currentImages = _(Faces)
          .map(({ ExternalImageId }) => ExternalImageId)
          .uniq()
          .value()

        const imagesToDelete = _.difference(currentImages, availableImages)
        const imagesToIndex = _.difference(availableImages, currentImages)

        // TODO: optimize the code below
        const facesToDelete = []
        _.forEach(imagesToDelete, (externalImageId) => {
          const images = _.filter(Faces, { ExternalImageId: externalImageId })

          _.forEach(images, ({ FaceId }) => {
            facesToDelete.push(FaceId)
          })
        })

        return Promise.props({
          deletedFaces: deleteFaces.bind(this)(imagesToDelete),
          indexedFaces: indexFacesFromImages.bind(this)(imagesToIndex)
        })
          .then(({ deletedFaces, indexedFaces }) => {
            const stop = _.now()
            const duration = _.round((stop - start) / 1000)

            return Logger.debug(`Synced reference face collection: ${Faces.length - deletedFaces + indexedFaces} faces available (time = ${duration}s, deleted = ${deletedFaces}, indexed = ${indexedFaces})`)
          })
      })
  }

  mentalSnapshot (photo) {
    const thumbnail = _.find(photo.processedFiles, { width: 84, height: 84 })

    return savePhoto.bind(this)(thumbnail)
      .then(() => thumbnail.url)
  }

  checkPhotosOut (photos) {
    const photosToCompare = _.filter(photos, (photo) => !photo.similarity_date)

    return Promise.map(photos, (photo) => {
      if (photo.similarity_date) {
        return photo.similarity // do not s3 and rekognition photos that have already been checked out
      }

      return savePhoto.bind(this)(photo)
        .then((image) => compareFacesFromImage.bind(this)(photo, image))
    }, { concurrency: 2 })
      .then((faceSimilarities) => {
        const faceSimilarityMax = _.max(faceSimilarities)
        const faceSimilarityMin = _.min(faceSimilarities)
        const faceSimilarityMean = _.round(_.mean(_.without(faceSimilarities, 0, undefined)), 2) || 0

        const like = !_.isEmpty(faceSimilarities) && faceSimilarityMean > 80

        return Logger.debug(`Compared ${photosToCompare.length} photo(s)`)
          .then(() => { return { faceSimilarities, faceSimilarityMax, faceSimilarityMin, faceSimilarityMean, like } })
      })
  }

  acquireTaste (photos) {
    return Promise.map(photos, (photo) => {
      const url = parse(photo.url)
      if (!url) {
        return
      }

      const srcKey = url.pathname
      const dstKey = srcKey.replace(`/${AWS_S3_BUCKET}/photos`, 'train')

      return this.s3.copyObject(srcKey, dstKey)
        .then(() => dstKey)
    }, { concurrency: 2 })
      .then((images) => indexFacesFromImages.bind(this)(images))
      .then((indexedFaces) => Logger.debug(`Indexed ${indexedFaces} face(s)`))
  }
}

module.exports = new Taste()