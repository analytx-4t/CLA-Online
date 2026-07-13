# Multi-Provider LLM Chatbot Application

A full-stack chatbot application that supports multiple Large Language Model (LLM) providers including OpenAI, DeepSeek, Gemini, and Groq, with MongoDB for session persistence and chat history management.

## Features

- **Multi-Provider LLM Support**: Seamlessly switch between OpenAI, DeepSeek, Gemini, and Groq
- **Chat Session Management**: Create, manage, and delete chat sessions
- **Session Persistence**: MongoDB-backed storage for chat history and metadata
- **Provider Health Monitoring**: Check which LLM providers are configured
- **Frontend Dashboard**: User-friendly interface for chat interactions
- **Extensible Architecture**: Easy to add new LLM providers

## Architecture

```
project_3/
├── backend/                      # Node.js backend server
│   ├── index.js                  # Main server entry point
│   ├── config.js                 # Environment configuration
│   ├── mongoClient.js            # MongoDB connection management
│   ├── llm/                      # LLM provider abstraction
│   │   ├── base.js               # Base provider class & errors
│   │   ├── factory.js            # Provider factory with caching
│   │   └── providers/            # Individual provider implementations
│   │       ├── openai_provider.js
│   │       ├── deepseek_provider.js
│   │       ├── gemini_provider.js
│   │       └── groq_provider.js
│   └── tests/                    # Backend tests
│       └── llm_provider.test.js
├── frontend/                     # Frontend application
│   ├── HTML/
│   │   ├── chatbot_interface.html
│   │   └── dashboard.html
│   ├── CSS/
│   │   └── chatbot_interface.css
│   ├── javascript/
│   │   └── chatbot_interface.js
│   └── assets/
│       ├── README.md
│       └── Images/
├── .env                          # Environment variables (create from .env.example)
├── .env.example                  # Environment configuration template
├── package.json                  # Node.js dependencies
├── requirements.txt              # Python dependencies (if needed)
└── README.md                     # This file
```

## Backend

The backend is a lightweight Node.js HTTP server built with native modules (no Express.js).

### Technology Stack

- **Runtime**: Node.js
- **Database**: MongoDB (via MongoDB Node.js Driver)
- **LLM SDKs**:
  - OpenAI SDK
  - Groq SDK
  - Google Generative AI SDK
- **Configuration**: dotenv for environment management

### Core Features

#### 1. LLM Provider System

The backend implements a provider abstraction pattern supporting multiple AI providers:

**Supported Providers:**
- **OpenAI**: GPT-4.1-mini and other OpenAI models
- **DeepSeek**: DeepSeek-v4-pro and DeepSeek-v4-flash
- **Gemini**: Google's Gemini models
- **Groq**: Llama and Mistral models via Groq

**Key Components:**
- `BaseLLMProvider`: Abstract base class defining the provider interface
- `factory.js`: Factory pattern implementation with provider caching
- Individual provider classes: Each handles authentication, request formatting, and response parsing
- Custom error hierarchy: Configuration, Authentication, Rate Limit, and Unavailability errors

#### 2. Chat Session Management

**Endpoints:**
- `POST /api/chat/sessions` - Create a new chat session
- `DELETE /api/chat/sessions/:id` - Delete a chat session and all associated messages
- `GET /api/chat/sessions` - (Planned) List all sessions for a user
- `POST /api/chat/sessions/:id/messages` - (Planned) Add messages to a session
- `GET /api/chat/sessions/:id/messages` - (Planned) Retrieve chat history

**Features:**
- Session ownership verification via user headers
- Automatic session ID generation
- Metadata tracking (created_at, updated_at, message_count, status)
- Cascading deletes for data integrity

#### 3. Provider Health Monitoring

- `GET /health` - Server health check
- `GET /api/llm/health` - Returns which LLM providers are configured (without exposing API keys)

### Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Server Configuration
PORT=3000

# MongoDB Configuration
MONGODB_URI=your_mongodb_connection_string

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini

# DeepSeek Configuration
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash

# Gemini Configuration
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=your_gemini_model_name

# Groq Configuration
GROQ_API_KEY=your_groq_api_key
GROQ_LLAMA_MODEL=llama-3.3-70b-versatile
GROQ_MISTRAL_MODEL=mistral-9b-22b

# Default LLM Configuration
DEFAULT_LLM_PROVIDER=openai
DEFAULT_LLM_MODEL=gpt-4.1-mini
```

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd project_3
   ```

2. **Install Node.js dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys and MongoDB connection string
   ```

4. **Start the server**
   ```bash
   npm start
   ```

   Or run in development mode (if configured):
   ```bash
   npm run dev
   ```

5. **Verify the server is running**
   ```bash
   curl http://localhost:3000/health
   ```

### Testing

Run the backend test suite:

```bash
npm test
```

### API Endpoints

#### Health Check
```
GET /health
Response: { "status": "ok" }
```

#### LLM Health Status
```
GET /api/llm/health
Response: {
  "openai": { "configured": true },
  "deepseek": { "configured": true },
  "gemini": { "configured": false },
  "groq": { "configured": true }
}
```

#### Generate LLM Response
```
POST /api/llm/generate
Headers: {
  "Content-Type": "application/json",
  "x-user-id": "user123"  // optional, defaults to 'unknown-user'
}
Body: {
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "systemPrompt": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "temperature": 0.7,
  "maxTokens": 256
}
Response: {
  "content": "Hello! How can I help you?",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 15,
    "total_tokens": 25
  }
}
```

#### Create Chat Session
```
POST /api/chat/sessions
Headers: {
  "x-user-id": "user123"
}
Body: {
  "title": "My First Chat",
  "session_id": "optional-custom-id"
}
Response: {
  "session": {
    "session_id": "uuid-here",
    "user_id": "user123",
    "title": "My First Chat",
    "created_at": "2025-10-21T...",
    "updated_at": "2025-10-21T...",
    "message_count": 0,
    "status": "active"
  }
}
```

#### Delete Chat Session
```
DELETE /api/chat/sessions/:sessionId
Headers: {
  "x-user-id": "user123"
}
Response: {
  "success": true,
  "session_id": "session-id"
}
```

## Frontend

The frontend consists of static HTML, CSS, and JavaScript files.

### Structure

- **HTML/chatbot_interface.html** - Main chatbot interface
- **HTML/dashboard.html** - Dashboard for managing sessions
- **CSS/chatbot_interface.css** - Styling for the chatbot
- **javascript/chatbot_interface.js** - Chatbot logic and API interactions
- **assets/** - Images and other static assets

### Features

- Interactive chat interface
- Multi-provider selection
- Session management
- Real-time message display

## Development

### Project Structure

The backend follows a modular architecture:

1. **Entry Point** (`index.js`): HTTP server with routing
2. **Configuration** (`config.js`): Centralized settings management
3. **Database** (`mongoClient.js`): MongoDB connection pooling
4. **LLM Layer** (`llm/`): Provider abstraction and implementations
5. **Tests** (`tests/`): Unit tests for providers

### Design Patterns

- **Factory Pattern**: LLM provider instantiation
- **Strategy Pattern**: Interchangeable LLM providers
- **Singleton Pattern**: Database connection management
- **Caching**: Provider instance caching for performance

### Adding a New LLM Provider

1. Create a new provider file in `backend/llm/providers/` (e.g., `newprovider_provider.js`)
2. Extend `BaseLLMProvider` and implement the `generate()` method
3. Add provider credentials to `config.js` in the `settings` object
4. Add a case in `getProviderConfig()` function
5. Import and register in `llm/factory.js`

Example:
```javascript
// backend/llm/providers/newprovider_provider.js
const { BaseLLMProvider } = require('../base');
const { settings, getProviderConfig } = require('../../config');

class NewProviderProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({ providerName: 'newprovider', defaultModel: model || settings.NEWPROVIDER_MODEL });
    this.config = getProviderConfig('newprovider');
    this.model = model || this.defaultModel;
  }

  async generate(request = {}) {
    // Implementation here
  }
}

module.exports = NewProviderProvider;
```

## Dependencies

### Node.js Dependencies
- `dotenv` - Environment variable management
- `mongodb` - MongoDB driver
- `openai` - OpenAI SDK
- `groq-sdk` - Groq API client
- `@google/generative-ai` - Google Gemini SDK

### Python Dependencies
- `flask` - Python web framework (if needed for additional services)
- `gunicorn` - WSGI server (if needed for additional services)

## Environment Variables

All sensitive configuration is managed through environment variables. See the Configuration section above for a complete list.

## Known Limitations

- No authentication middleware (user ID extracted from headers)
- No input validation schema
- No rate limiting
- Limited error middleware (inline error handling)
- Some endpoints are planned but not yet implemented (message CRUD, session listing)

## License

[Your License Here]

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## Support

For issues and questions, please use the issue tracker.