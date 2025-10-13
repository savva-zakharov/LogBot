const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs'); // Use standard fs for existsSync
const path = require('path');

const MEMES_DIR = path.join(process.cwd(), '.memes');

// Function to dynamically build the meme command
async function buildMemeCommand() {
    const memeCommand = new SlashCommandBuilder()
        .setName('meme')
        .setDescription('Responds with a meme!')
        .addStringOption(option =>
            option.setName('meme')
                .setDescription("The name of the meme to send, 'random', or leave blank for a list.")
                .setRequired(false)
        );

    try {
        if (!fs.existsSync(MEMES_DIR)) {
            console.warn(`⚠️ Memes directory not found at ${MEMES_DIR}. No meme commands will be loaded.`);
            return memeCommand;
        }

        const files = await fs.promises.readdir(MEMES_DIR);
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
        });

        if (imageFiles.length === 0) {
            console.log(`ℹ️ No image files found in ${MEMES_DIR}. No meme commands will be loaded.`);
        } else {
            console.log(`✅ Loaded ${imageFiles.length} memes: ${imageFiles.map(file => path.parse(file).name).join(', ')}`);
        }

    } catch (error) {
        console.error(`❌ Error building meme command:`, error);
    }

    return memeCommand;
}

module.exports = {
    // Export a function to build the command data dynamically
    buildMemeCommand,
    // The execute function will handle the logic based on the optional arguments
    async execute(interaction) {
        const memeName = interaction.options.getString('meme');

        try {
            if (!fs.existsSync(MEMES_DIR)) {
                await interaction.reply({ content: 'No memes available.', ephemeral: true });
                return;
            }

            const filesInDir = await fs.promises.readdir(MEMES_DIR);
            const imageFiles = filesInDir.filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
            });

            if (imageFiles.length === 0) {
                await interaction.reply({ content: 'No memes available.', ephemeral: true });
                return;
            }

            // If no meme name is provided, list available memes
            if (!memeName) {
                const memeList = imageFiles.map(file => `\`${path.parse(file).name}\``).join(', ');
                await interaction.reply({ content: `**Available memes:**\n${memeList}`, ephemeral: true });
                return;
            }

            let selectedMemeFile;

            if (memeName.toLowerCase() === 'random') {
                // Send a random one
                const randomIndex = Math.floor(Math.random() * imageFiles.length);
                selectedMemeFile = imageFiles[randomIndex];
            } else {
                // Meme name provided, find the specific one
                selectedMemeFile = imageFiles.find(f => path.parse(f).name.toLowerCase() === memeName.toLowerCase());
                if (!selectedMemeFile) {
                    const memeList = imageFiles.map(file => `\`${path.parse(file).name}\``).join(', ');
                    await interaction.reply({ content: `Meme acktick${memeName}acktick not found. Please choose from the available memes:\n${memeList}`, ephemeral: true });
                    return;
                }
            }

            const attachment = new AttachmentBuilder(path.join(MEMES_DIR, selectedMemeFile));
            await interaction.reply({ files: [attachment] });

        } catch (error) {
            console.error(`❌ Error sending meme '${memeName}':`, error);
            await interaction.reply({ content: 'There was an error sending the meme.', ephemeral: true });
        }
    },
};
