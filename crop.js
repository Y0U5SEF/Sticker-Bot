/**
 * A self-contained Node.js script to test video cropping using ffmpeg.
 * This script demonstrates how to adapt the original function to take a file path
 * as input and provides a full runnable example.
 *
 * Requirements:
 * 1. An input video file (e.g., 'input.mp4') in the same directory.
 * 2. Node.js dependencies: 'fluent-ffmpeg' and 'ffmpeg-static'.
 *
 * To run this script:
 * 1. Make sure you have Node.js installed.
 * 2. In your project directory, run: `npm install fluent-ffmpeg ffmpeg-static`
 * 3. Save this code as 'test.js'.
 * 4. Replace 'your-input-video.mp4' with the name of your video file.
 * 5. Run the script: `node test.js`
 */

// Import necessary modules
const path = require('path');
const os = require('os');
const { promises: fsp } = require('fs');

// The ffmpeg wrapper and static binary are required.
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Set the path to the static ffmpeg binary to prevent errors.
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Mocks the MessageMedia object with a base64-encoded file.
 * In a real scenario, this object would come from your bot's API.
 * This function is for testing purposes only.
 * @param {string} filePath The path to the input video file.
 * @returns {Promise<{data: string}>} A mock MessageMedia object with base64 data.
 */
async function createMessageMediaMock(filePath) {
  try {
    const fileBuffer = await fsp.readFile(filePath);
    return {
      data: fileBuffer.toString('base64'),
    };
  } catch (error) {
    console.error(`Error reading file at ${filePath}:`, error);
    throw error;
  }
}

/**
 * Crops a video file to a square and applies other transformations.
 * This is a modified version of your original function, adapted for testing.
 * @param {object} messageMedia A mock object with a `data` property containing base64 video data.
 * @param {object} options Options for cropping.
 * @param {number} options.maxDur The maximum duration in seconds for the output video.
 * @param {number} options.size The size of the square output in pixels.
 * @param {number} options.fps The frames per second for the output video.
 * @returns {Promise<string>} The path to the cropped output video file.
 */
async function cropVideoToSquareFile(messageMedia, { maxDur = 8, size = 512, fps = 15 } = {}) {
  // Use a unique name for input and output files to prevent conflicts.
  const inFile = path.join(os.tmpdir(), `in_${Date.now()}.mp4`);
  const outFile = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);

  // Write the base64 data to a temporary input file.
  await fsp.writeFile(inFile, Buffer.from(messageMedia.data, 'base64'));

  // Define the video filter string for ffmpeg.
  const vf = [
    "crop='min(iw,ih)':'min(iw,ih)'", // Crop to a perfect square.
    `scale=${size}:${size}:flags=lanczos`, // Scale to the specified size.
    `fps=${fps}` // Set the output frames per second.
  ].join(',');

  // Use a Promise to handle the asynchronous ffmpeg process.
  return new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .noAudio() // Remove the audio track.
      .videoCodec('libx264') // Set the video codec.
      .outputOptions([
        '-preset veryfast', // Use a faster encoding preset.
        `-t ${maxDur}`, // Limit the duration of the output video.
        '-movflags +faststart', // Optimize for web playback.
        '-pix_fmt yuv420p' // Set pixel format for broader compatibility.
      ])
      .videoFilters(vf) // Apply the defined video filters.
      .on('error', (err) => {
        // Log the error and reject the promise.
        console.error('An error occurred during video processing: ' + err.message);
        reject(err);
      })
      .on('end', () => {
        // The process finished successfully. Resolve with the output file path.
        console.log('Video cropping and conversion finished successfully.');
        resolve(outFile);
      })
      .save(outFile); // Start the conversion and save to the output file.
  }).finally(async () => {
    // Clean up the temporary input file regardless of success or failure.
    try {
      await fsp.unlink(inFile);
      console.log(`Cleaned up temporary input file: ${inFile}`);
    } catch (err) {
      console.error('Error cleaning up input file:', err);
    }
  });
}

// --- Main execution function for testing ---
async function runTest() {
  const inputFilePath = path.join(__dirname, 'giphy.gif'); // <-- REPLACE THIS WITH YOUR VIDEO FILE'S NAME

  console.log(`Starting video cropping test for: ${inputFilePath}`);
  
  try {
    // 1. Create a mock MessageMedia object from the input file.
    const messageMediaMock = await createMessageMediaMock(inputFilePath);
    
    // 2. Call the main cropping function with the mock data.
    const outputFilePath = await cropVideoToSquareFile(messageMediaMock);

    // 3. Log the path of the successfully created output file.
    console.log(`\nSuccess! The cropped video is located at: ${outputFilePath}`);
    console.log(`You can now check the file to see the result.`);

  } catch (err) {
    console.error(`\nTest failed. An error occurred: ${err.message}`);
    process.exit(1); // Exit with a failure code.
  }
}

// Run the test.
runTest();
